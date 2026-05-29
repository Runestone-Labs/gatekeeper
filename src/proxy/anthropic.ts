/**
 * Anthropic model-call proxy.
 *
 * A streaming passthrough so agents can route Anthropic `/v1/messages` (and
 * sibling endpoints) THROUGH gatekeeper instead of calling Anthropic directly.
 * This brings model-inference calls under the control plane: every call is
 * audited, the key can live only in gatekeeper, and a policy seam exists to deny
 * later. Unlike the buffered `http.request` tool, this streams the SSE response
 * so token-by-token generation works.
 *
 * The SDK/CLI points `ANTHROPIC_BASE_URL` at `<gatekeeper>/anthropic`, then calls
 * `<gatekeeper>/anthropic/v1/messages`; this route forwards to
 * `https://api.anthropic.com/v1/messages`.
 *
 * SSRF-safe by construction: the upstream host is hardcoded; the wildcard only
 * controls the path.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { logToolRequest, logToolExecution } from '../audit/logger.js';

const ANTHROPIC_UPSTREAM = 'https://api.anthropic.com';
const PROXY_TOOL = 'anthropic.proxy';
const TTFB_TIMEOUT_MS = 600_000; // time-to-first-byte only; not applied mid-stream
const MAX_BODY_BYTES = 32 * 1024 * 1024; // LLM contexts can be large

/** Request headers we never forward upstream (hop-by-hop / auth we replace / host). */
const DROP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'accept-encoding',
  'authorization',
  'x-api-key',
]);

/** Response headers we never forward back (native fetch already decoded the body). */
const DROP_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
]);

type Actor = { type: 'agent'; name: string; role: string };

/** Build the upstream URL from the wildcard subpath + querystring. Host is fixed. */
export function buildUpstreamUrl(wildcardPath: string, search: string): string {
  const clean = wildcardPath.replace(/^\/+/, '');
  return `${ANTHROPIC_UPSTREAM}/${clean}${search || ''}`;
}

/** Forward client headers minus hop-by-hop/auth; inject the upstream key + defaults. */
export function buildUpstreamHeaders(
  clientHeaders: Record<string, string | string[] | undefined>,
  apiKey: string
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(clientHeaders)) {
    if (v === undefined) continue;
    if (DROP_REQUEST_HEADERS.has(k.toLowerCase())) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  if (apiKey) out['x-api-key'] = apiKey;
  if (!out['anthropic-version'] && !out['Anthropic-Version'])
    out['anthropic-version'] = '2023-06-01';
  if (!out['content-type'] && !out['Content-Type']) out['content-type'] = 'application/json';
  return out;
}

/** Keep upstream response headers except those invalidated by decoding/re-streaming. */
export function filterResponseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (!DROP_RESPONSE_HEADERS.has(key.toLowerCase())) out[key] = value;
  });
  return out;
}

/** A non-secret summary of the request body for audit (model + shape, never content). */
export function summarizeAnthropicBody(body: unknown): string {
  if (!body || typeof body !== 'object') return '{}';
  const b = body as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  if (typeof b.model === 'string') summary.model = b.model;
  if (typeof b.stream === 'boolean') summary.stream = b.stream;
  if (Array.isArray(b.messages)) summary.messages = b.messages.length;
  if (typeof b.max_tokens === 'number') summary.max_tokens = b.max_tokens;
  return JSON.stringify(summary);
}

/** Derive the acting principal from optional headers (default: the openclaw agent). */
export function extractActor(headers: Record<string, string | string[] | undefined>): Actor {
  const name = headerStr(headers['x-runestone-actor']) || 'openclaw';
  const role = headerStr(headers['x-runestone-role']) || 'openclaw';
  return { type: 'agent', name, role };
}

function headerStr(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

/** Register the proxy route (no-op unless ENABLE_ANTHROPIC_PROXY=true). */
export function registerAnthropicProxy(app: FastifyInstance): void {
  if (!config.enableAnthropicProxy) return;

  app.all<{ Params: { '*': string } }>(
    '/anthropic/*',
    { bodyLimit: MAX_BODY_BYTES },
    async (request: FastifyRequest<{ Params: { '*': string } }>, reply: FastifyReply) => {
      const requestId = randomUUID();
      const actor = extractActor(request.headers);
      const search = request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : '';
      const url = buildUpstreamUrl(request.params['*'] ?? '', search);
      const argsSummary = summarizeAnthropicBody(request.body);

      // Policy seam: audited + allowed (observe-first, like budgets). A future
      // policy evaluation would deny here.
      logToolRequest({
        requestId,
        tool: PROXY_TOOL,
        decision: 'allow',
        actor,
        argsSummary,
        riskFlags: [],
      });

      const apiKey = config.anthropicApiKey || headerStr(request.headers['x-api-key']) || '';
      const headers = buildUpstreamHeaders(request.headers, apiKey);
      const method = request.method.toUpperCase();
      const hasBody = method !== 'GET' && method !== 'HEAD' && request.body != null;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TTFB_TIMEOUT_MS);
      let upstream: Response;
      try {
        upstream = await fetch(url, {
          method,
          headers,
          body: hasBody ? JSON.stringify(request.body) : undefined,
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        logToolExecution({
          requestId,
          tool: PROXY_TOOL,
          actor,
          argsSummary,
          resultSummary: `upstream error: ${(err as Error).message}`,
          riskFlags: ['proxy:upstream_error'],
        });
        reply
          .status(502)
          .send({ error: `Anthropic proxy upstream error: ${(err as Error).message}` });
        return reply;
      }
      clearTimeout(timer); // headers received; do not abort mid-stream

      logToolExecution({
        requestId,
        tool: PROXY_TOOL,
        actor,
        argsSummary,
        resultSummary: `status ${upstream.status}`,
        riskFlags: upstream.ok ? [] : ['proxy:non_2xx'],
      });

      reply.status(upstream.status);
      for (const [k, v] of Object.entries(filterResponseHeaders(upstream.headers))) {
        reply.header(k, v);
      }
      // Stream the (possibly SSE) body through; Fastify pipes a Node Readable.
      return reply.send(
        upstream.body
          ? Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0])
          : ''
      );
    }
  );

  app.log.info('Anthropic model-call proxy enabled at /anthropic/*');
}
