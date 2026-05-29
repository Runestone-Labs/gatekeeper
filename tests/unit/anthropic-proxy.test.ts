import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

// Hoisted so they're available inside the (hoisted) vi.mock factories below.
const { mockConfig, logToolRequest, logToolExecution } = vi.hoisted(() => ({
  // Mutable mocked config so tests can toggle the proxy on/off.
  mockConfig: { enableAnthropicProxy: true, anthropicApiKey: 'gk-injected-key' },
  logToolRequest: vi.fn(),
  logToolExecution: vi.fn(),
}));
vi.mock('../../src/config.js', () => ({ config: mockConfig }));
vi.mock('../../src/audit/logger.js', () => ({ logToolRequest, logToolExecution }));

import {
  buildUpstreamUrl,
  buildUpstreamHeaders,
  filterResponseHeaders,
  summarizeAnthropicBody,
  extractActor,
  registerAnthropicProxy,
} from '../../src/proxy/anthropic.js';

describe('anthropic proxy — pure helpers', () => {
  it('buildUpstreamUrl pins the host and preserves path + query', () => {
    expect(buildUpstreamUrl('v1/messages', '?beta=1')).toBe(
      'https://api.anthropic.com/v1/messages?beta=1'
    );
    expect(buildUpstreamUrl('/v1/messages/count_tokens', '')).toBe(
      'https://api.anthropic.com/v1/messages/count_tokens'
    );
  });

  it('buildUpstreamHeaders drops auth/host, injects the key, sets defaults', () => {
    const h = buildUpstreamHeaders(
      {
        host: 'localhost:3847',
        authorization: 'Bearer leaked',
        'x-api-key': 'client-key',
        'accept-encoding': 'gzip',
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      'gk-injected-key'
    );
    expect(h.host).toBeUndefined();
    expect(h.authorization).toBeUndefined();
    expect(h['accept-encoding']).toBeUndefined();
    expect(h['x-api-key']).toBe('gk-injected-key'); // injected, not the client's
    expect(h['anthropic-beta']).toBe('prompt-caching-2024-07-31'); // preserved
    expect(h['anthropic-version']).toBe('2023-06-01'); // default added
    expect(h['content-type']).toBe('application/json');
  });

  it('filterResponseHeaders drops encoding/length but keeps content-type', () => {
    const headers = new Headers({
      'content-type': 'text/event-stream',
      'content-encoding': 'gzip',
      'content-length': '123',
      'request-id': 'req_abc',
    });
    const out = filterResponseHeaders(headers);
    expect(out['content-type']).toBe('text/event-stream');
    expect(out['request-id']).toBe('req_abc');
    expect(out['content-encoding']).toBeUndefined();
    expect(out['content-length']).toBeUndefined();
  });

  it('summarizeAnthropicBody captures shape but never message content', () => {
    const summary = summarizeAnthropicBody({
      model: 'claude-opus-4-7',
      stream: true,
      max_tokens: 8192,
      messages: [{ role: 'user', content: 'SECRET PROMPT' }],
    });
    const parsed = JSON.parse(summary);
    expect(parsed).toEqual({
      model: 'claude-opus-4-7',
      stream: true,
      messages: 1,
      max_tokens: 8192,
    });
    expect(summary).not.toContain('SECRET PROMPT');
  });

  it('extractActor defaults to the openclaw agent and reads override headers', () => {
    expect(extractActor({})).toEqual({ type: 'agent', name: 'openclaw', role: 'openclaw' });
    expect(
      extractActor({ 'x-runestone-actor': 'researcher', 'x-runestone-role': 'analyst' })
    ).toEqual({
      type: 'agent',
      name: 'researcher',
      role: 'analyst',
    });
  });
});

describe('anthropic proxy — route', () => {
  beforeEach(() => {
    mockConfig.enableAnthropicProxy = true;
    mockConfig.anthropicApiKey = 'gk-injected-key';
    logToolRequest.mockClear();
    logToolExecution.mockClear();
  });

  it('forwards to Anthropic, injects the key, streams the response, and audits', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('{"id":"msg_1"}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    const app = Fastify();
    registerAnthropicProxy(app);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/anthropic/v1/messages',
      headers: { 'content-type': 'application/json', 'x-api-key': 'client-key' },
      payload: {
        model: 'claude-opus-4-7',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('msg_1');

    // Forwarded to the real Anthropic host with the INJECTED key (not the client's).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe('https://api.anthropic.com/v1/messages');
    expect(calledInit.method).toBe('POST');
    expect((calledInit.headers as Record<string, string>)['x-api-key']).toBe('gk-injected-key');
    expect(calledInit.body).toContain('claude-opus-4-7');

    // Audited both the request and the execution under the proxy tool.
    expect(logToolRequest).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'anthropic.proxy', decision: 'allow' })
    );
    expect(logToolExecution).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'anthropic.proxy', resultSummary: 'status 200' })
    );

    await app.close();
    vi.unstubAllGlobals();
  });

  it('returns 502 and audits when the upstream fetch throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      })
    );
    const app = Fastify();
    registerAnthropicProxy(app);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/anthropic/v1/messages',
      headers: { 'content-type': 'application/json' },
      payload: { model: 'claude-opus-4-7', messages: [] },
    });

    expect(res.statusCode).toBe(502);
    expect(logToolExecution).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'anthropic.proxy', riskFlags: ['proxy:upstream_error'] })
    );
    await app.close();
    vi.unstubAllGlobals();
  });

  it('does not register the route when disabled', async () => {
    mockConfig.enableAnthropicProxy = false;
    const app = Fastify();
    registerAnthropicProxy(app);
    await app.ready();
    const res = await app.inject({ method: 'POST', url: '/anthropic/v1/messages', payload: {} });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
