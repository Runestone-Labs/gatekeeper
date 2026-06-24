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
import { priceCall } from '../pricing/index.js';
import type { ModelCallUsage, PolicyEvaluation } from '../types.js';

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

type Actor = { type: 'agent'; name: string; role: string; runId?: string };

/**
 * Optional pre-forward budget gate. Returns a denial to block the model call
 * (e.g. a per-run cap already exceeded), or null to permit it. Injected by the
 * server so the proxy stays decoupled from policy/sink wiring. Absent ⇒ no
 * enforcement (observe-first default).
 */
export type ProxyBudgetCheck = (actor: Actor) => Promise<PolicyEvaluation | null>;

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

/**
 * Derive the acting principal from optional headers (default: the openclaw agent).
 * `x-runestone-run-id` correlates every call in one agentic run, so per-run
 * budgets can cap a single run's spend at the action boundary.
 */
export function extractActor(headers: Record<string, string | string[] | undefined>): Actor {
  const name = headerStr(headers['x-runestone-actor']) || 'openclaw';
  const role = headerStr(headers['x-runestone-role']) || 'openclaw';
  const runId = headerStr(headers['x-runestone-run-id']);
  return runId ? { type: 'agent', name, role, runId } : { type: 'agent', name, role };
}

function headerStr(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

/** Coerce a number-or-numeric-string to a finite number, else null. */
function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Merge a raw Anthropic `usage` object into an accumulator using max semantics
 * (SSE counters are cumulative across events). Returns true if any token field
 * was present. Raw shape: { input_tokens, output_tokens,
 * cache_read_input_tokens, cache_creation_input_tokens }.
 */
export function mergeAnthropicUsage(acc: ModelCallUsage, raw: Record<string, unknown>): boolean {
  let touched = false;
  const inp = toNum(raw.input_tokens);
  if (inp != null) {
    acc.inputTokens = Math.max(acc.inputTokens, inp);
    touched = true;
  }
  const out = toNum(raw.output_tokens);
  if (out != null) {
    acc.outputTokens = Math.max(acc.outputTokens, out);
    touched = true;
  }
  const cr = toNum(raw.cache_read_input_tokens);
  if (cr != null) {
    acc.cacheReadTokens = Math.max(acc.cacheReadTokens ?? 0, cr);
    touched = true;
  }
  const cc = toNum(raw.cache_creation_input_tokens);
  if (cc != null) {
    acc.cacheCreationTokens = Math.max(acc.cacheCreationTokens ?? 0, cc);
    touched = true;
  }
  return touched;
}

/** Extract usage from a non-streaming `/v1/messages` JSON response body. */
export function extractUsageFromJson(text: string): ModelCallUsage | null {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  const u = (obj as { usage?: Record<string, unknown> } | null)?.usage;
  if (!u || typeof u !== 'object') return null;
  const acc: ModelCallUsage = { inputTokens: 0, outputTokens: 0 };
  return mergeAnthropicUsage(acc, u) ? acc : null;
}

/**
 * Drain an SSE stream and accumulate token usage from `message_start`
 * (input/cache tokens) and `message_delta` (final cumulative output tokens).
 * Parses incrementally so the full body is never buffered. Returns null if no
 * usage was seen (e.g. the stream errored before emitting any).
 */
export async function consumeSSEUsage(
  stream: ReadableStream<Uint8Array>
): Promise<ModelCallUsage | null> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const acc: ModelCallUsage = { inputTokens: 0, outputTokens: 0 };
  let sawUsage = false;
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let evt: { usage?: Record<string, unknown>; message?: { usage?: Record<string, unknown> } };
        try {
          evt = JSON.parse(payload);
        } catch {
          continue;
        }
        const u = evt.usage ?? evt.message?.usage;
        if (u && typeof u === 'object') sawUsage = mergeAnthropicUsage(acc, u) || sawUsage;
      }
    }
  } catch {
    /* stream aborted/closed early — return whatever we accumulated */
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
  return sawUsage ? acc : null;
}

/** Is this the billable message-generation endpoint (not count_tokens)? */
function isMessagesEndpoint(wildcardPath: string, method: string): boolean {
  return method === 'POST' && /^\/?v1\/messages\/?$/.test(wildcardPath);
}

/**
 * Strip an optional `_run/<id>/` prefix that carries the run id via the base
 * URL path. The Claude Agent SDK can't set custom HTTP headers on Anthropic
 * calls, but it CAN set ANTHROPIC_BASE_URL per run — so a caller routes through
 * `<gatekeeper>/anthropic/_run/<runId>` and we recover the id here. Returns the
 * real upstream subpath plus the decoded run id (if present).
 */
export function stripRunPrefix(wildcardPath: string): { path: string; runId?: string } {
  const m = wildcardPath.replace(/^\/+/, '').match(/^_run\/([^/]+)\/?(.*)$/);
  if (!m) return { path: wildcardPath };
  return { path: m[2] ?? '', runId: decodeURIComponent(m[1]) };
}

/** Price usage for a model; null cost when the model isn't in the table. */
function costFor(model: string | undefined, usage: ModelCallUsage | null): number | null {
  if (!usage || !model) return null;
  return priceCall(model, usage).costUsd;
}

/** Register the proxy route (no-op unless ENABLE_ANTHROPIC_PROXY=true). */
export function registerAnthropicProxy(app: FastifyInstance, budgetCheck?: ProxyBudgetCheck): void {
  if (!config.enableAnthropicProxy) return;

  app.all<{ Params: { '*': string } }>(
    '/anthropic/*',
    { bodyLimit: MAX_BODY_BYTES },
    async (request: FastifyRequest<{ Params: { '*': string } }>, reply: FastifyReply) => {
      const requestId = randomUUID();
      // The run id may arrive as a header (TS client / direct HTTP) OR as an
      // `_run/<id>/` base-URL prefix (the Agent SDK, which can't set headers).
      const { path: rawPath, runId: pathRunId } = stripRunPrefix(request.params['*'] ?? '');
      const actor = extractActor(request.headers);
      if (pathRunId && !actor.runId) actor.runId = pathRunId;
      const search = request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : '';
      const url = buildUpstreamUrl(rawPath, search);
      const argsSummary = summarizeAnthropicBody(request.body);

      // Per-run / per-actor budget gate at the ACTION boundary: if the run has
      // already burned its cap, deny BEFORE the (costly) model call. No-op
      // unless a budget rule matches the actor (observe-first default).
      if (budgetCheck) {
        const denial = await budgetCheck(actor);
        if (denial) {
          logToolRequest({
            requestId,
            tool: PROXY_TOOL,
            decision: 'deny',
            actor,
            argsSummary,
            riskFlags: denial.riskFlags,
            reasonCode: denial.reasonCode,
            humanExplanation: denial.humanExplanation,
            remediation: denial.remediation,
          });
          reply.status(403).send({
            type: 'error',
            error: { type: 'budget_exceeded', message: denial.humanExplanation },
            reasonCode: denial.reasonCode,
            remediation: denial.remediation,
          });
          return reply;
        }
      }

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

      const riskFlags = upstream.ok ? [] : ['proxy:non_2xx'];
      const reqModel = (request.body as { model?: unknown } | undefined)?.model;
      const model = typeof reqModel === 'string' ? reqModel : undefined;
      const billable = isMessagesEndpoint(rawPath, method);
      const isSSE = (upstream.headers.get('content-type') ?? '').includes('text/event-stream');

      // One audit row per call. For billable /v1/messages calls we stamp real
      // token usage + USD cost so budgets meter ACTUAL spend, not a flat rate.
      const logExecution = (usage: ModelCallUsage | null): void => {
        logToolExecution({
          requestId,
          tool: PROXY_TOOL,
          actor,
          argsSummary,
          resultSummary: `status ${upstream.status}`,
          riskFlags,
          model: usage ? model : undefined,
          usage: usage ?? undefined,
          costUsd: usage ? costFor(model, usage) : undefined,
        });
      };

      reply.status(upstream.status);
      for (const [k, v] of Object.entries(filterResponseHeaders(upstream.headers))) {
        reply.header(k, v);
      }

      if (!upstream.body) {
        logExecution(null);
        return reply.send('');
      }

      // Non-SSE (single JSON blob): buffer, parse usage, log, then send. No
      // streaming benefit is lost — a non-stream response is one object anyway.
      if (!isSSE) {
        const text = await upstream.text();
        logExecution(billable ? extractUsageFromJson(text) : null);
        return reply.send(text);
      }

      // SSE: tee so the client streams token-by-token uninterrupted while a
      // background consumer drains the second branch to parse usage and logs
      // once the stream finishes (the audit row lands a moment after the end).
      const [toClient, toMeter] = upstream.body.tee();
      void (async () => {
        const parsed = await consumeSSEUsage(toMeter);
        logExecution(billable ? parsed : null);
      })();
      return reply.send(Readable.fromWeb(toClient as Parameters<typeof Readable.fromWeb>[0]));
    }
  );

  app.log.info('Anthropic model-call proxy enabled at /anthropic/*');
}
