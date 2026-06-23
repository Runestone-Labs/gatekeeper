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
  mergeAnthropicUsage,
  extractUsageFromJson,
  consumeSSEUsage,
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

  it('extractActor threads x-runestone-run-id for per-run correlation', () => {
    expect(extractActor({ 'x-runestone-run-id': 'run-123' })).toEqual({
      type: 'agent',
      name: 'openclaw',
      role: 'openclaw',
      runId: 'run-123',
    });
    // No runId key when the header is absent (keeps existing actor shape).
    expect('runId' in extractActor({})).toBe(false);
  });
});

describe('anthropic proxy — usage parsing', () => {
  it('mergeAnthropicUsage coerces string counts and takes the max (cumulative SSE)', () => {
    const acc = { inputTokens: 0, outputTokens: 0 };
    expect(
      mergeAnthropicUsage(acc, { input_tokens: '1000', cache_read_input_tokens: 200 })
    ).toBe(true);
    mergeAnthropicUsage(acc, { output_tokens: 10 });
    mergeAnthropicUsage(acc, { output_tokens: 500 }); // later delta supersedes
    expect(acc).toEqual({ inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200 });
    expect(mergeAnthropicUsage({ inputTokens: 0, outputTokens: 0 }, { foo: 1 })).toBe(false);
  });

  it('extractUsageFromJson reads usage from a non-streaming message body', () => {
    const usage = extractUsageFromJson(
      JSON.stringify({
        id: 'msg_1',
        usage: {
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_input_tokens: 200,
          cache_creation_input_tokens: 50,
        },
      })
    );
    expect(usage).toEqual({
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheCreationTokens: 50,
    });
    expect(extractUsageFromJson('{"id":"msg_1"}')).toBeNull();
    expect(extractUsageFromJson('not json')).toBeNull();
  });

  it('consumeSSEUsage accumulates input from message_start and final output from message_delta', async () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":1000,"cache_read_input_tokens":200,"output_tokens":1}}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","usage":{"output_tokens":500}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');
    const stream = new Response(sse).body as ReadableStream<Uint8Array>;
    const usage = await consumeSSEUsage(stream);
    expect(usage).toEqual({ inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200 });
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

  it('stamps real token usage + USD cost on the audit row (non-streaming)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: 'msg_1',
              usage: {
                input_tokens: 1000,
                output_tokens: 500,
                cache_read_input_tokens: 200,
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
      )
    );
    const app = Fastify();
    registerAnthropicProxy(app);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/anthropic/v1/messages',
      headers: { 'content-type': 'application/json', 'x-runestone-run-id': 'run-xyz' },
      payload: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('msg_1');

    // run-id flows onto the audited actor for per-run budget correlation.
    expect(logToolRequest.mock.calls[0][0].actor).toEqual(
      expect.objectContaining({ runId: 'run-xyz' })
    );

    // Execution row carries model, usage, and real cost.
    const execArg = logToolExecution.mock.calls[0][0];
    expect(execArg.tool).toBe('anthropic.proxy');
    expect(execArg.model).toBe('claude-opus-4-7');
    expect(execArg.usage).toEqual({ inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200 });
    // opus-4-7: 1000*15 + 500*75 + 200*1.5 per 1M = 0.015 + 0.0375 + 0.0003
    expect(execArg.costUsd).toBeCloseTo(0.0528, 6);

    await app.close();
    vi.unstubAllGlobals();
  });

  it('budget gate denies (403) and audits without forwarding when the run cap is hit', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const app = Fastify();
    registerAnthropicProxy(app, async () => ({
      decision: 'deny',
      reason: 'Budget "per-run" exceeded',
      reasonCode: 'RUN_BUDGET_EXCEEDED',
      humanExplanation: 'Run run-1 has spent $5.50 of the $5.00 "per-run" budget.',
      remediation: 'Start a new run or raise the ceiling.',
      riskFlags: ['budget_exceeded', 'run_budget_exceeded'],
    }));
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/anthropic/v1/messages',
      headers: { 'content-type': 'application/json', 'x-runestone-run-id': 'run-1' },
      payload: { model: 'claude-opus-4-7', messages: [] },
    });

    expect(res.statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled(); // never reached the upstream model call
    expect(JSON.parse(res.body).reasonCode).toBe('RUN_BUDGET_EXCEEDED');
    expect(logToolRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: 'anthropic.proxy',
        decision: 'deny',
        reasonCode: 'RUN_BUDGET_EXCEEDED',
      })
    );

    await app.close();
    vi.unstubAllGlobals();
  });

  it('budget gate permits (null) → forwards the call as normal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{"id":"msg_ok"}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
      )
    );
    const app = Fastify();
    registerAnthropicProxy(app, async () => null);
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/anthropic/v1/messages',
      headers: { 'content-type': 'application/json' },
      payload: { model: 'claude-opus-4-7', messages: [] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('msg_ok');
    await app.close();
    vi.unstubAllGlobals();
  });

  it('parses usage from a streamed SSE response without breaking the stream', async () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":1000,"cache_read_input_tokens":200,"output_tokens":1}}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","usage":{"output_tokens":500}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      )
    );
    const app = Fastify();
    registerAnthropicProxy(app);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/anthropic/v1/messages',
      headers: { 'content-type': 'application/json' },
      payload: { model: 'claude-opus-4-7', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    });
    // Client still receives the full SSE body unmodified.
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('message_delta');

    // Usage is parsed off the teed branch and logged once the stream completes.
    await vi.waitFor(() => {
      const exec = logToolExecution.mock.calls.find((c) => c[0].usage);
      expect(exec).toBeTruthy();
      expect(exec![0].usage).toEqual({ inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200 });
      expect(exec![0].costUsd).toBeCloseTo(0.0528, 6);
    });

    await app.close();
    vi.unstubAllGlobals();
  });
});
