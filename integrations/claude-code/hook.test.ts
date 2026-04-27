import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { mapClaudeCodeTool, evaluate, buildHookResponse, run } from './hook.js';

describe('mapClaudeCodeTool', () => {
  it('maps Bash → shell.exec', () => {
    const r = mapClaudeCodeTool('Bash', { command: 'ls', cwd: '/tmp' });
    expect(r).toEqual({ tool: 'shell.exec', args: { command: 'ls', cwd: '/tmp' } });
  });

  it('maps Write → files.write using file_path', () => {
    const r = mapClaudeCodeTool('Write', { file_path: '/tmp/x.txt', content: 'hi' });
    expect(r).toEqual({ tool: 'files.write', args: { path: '/tmp/x.txt', content: 'hi' } });
  });

  it('maps Edit → files.write using new_string as content', () => {
    const r = mapClaudeCodeTool('Edit', {
      file_path: '/tmp/x.txt',
      old_string: 'a',
      new_string: 'b',
    });
    expect(r).toEqual({ tool: 'files.write', args: { path: '/tmp/x.txt', content: 'b' } });
  });

  it('maps WebFetch → http.request', () => {
    const r = mapClaudeCodeTool('WebFetch', { url: 'https://example.com' });
    expect(r).toEqual({
      tool: 'http.request',
      args: { url: 'https://example.com', method: 'GET' },
    });
  });

  it('returns null for un-gated tools (Read, Glob, MCP, etc.)', () => {
    expect(mapClaudeCodeTool('Read', { file_path: '/etc/hosts' })).toBeNull();
    expect(mapClaudeCodeTool('Glob', { pattern: '*' })).toBeNull();
    expect(mapClaudeCodeTool('mcp__github__create_issue', {})).toBeNull();
  });
});

describe('buildHookResponse', () => {
  const mapped = { tool: 'shell.exec', args: { command: 'security delete-generic-password -s X' } };

  it('exit 0 with no stdout when allowed', () => {
    const r = buildHookResponse({ decision: 'allow' }, mapped);
    expect(r.exit).toBe(0);
    expect(r.stdout).toBeUndefined();
  });

  it('emits a block JSON with the human explanation when denied', () => {
    const r = buildHookResponse(
      {
        decision: 'deny',
        reasonCode: 'BOUNDARY_DENIED',
        humanExplanation: 'Deleting Keychain credentials is destructive.',
        remediation: 'Run it manually outside Claude Code.',
      },
      mapped
    );
    expect(r.exit).toBe(0);
    expect(r.stdout).toBeDefined();
    const parsed = JSON.parse(r.stdout!);
    expect(parsed.decision).toBe('block');
    expect(parsed.reason).toContain('Deleting Keychain credentials');
    expect(parsed.reason).toContain('BOUNDARY_DENIED');
    expect(parsed.reason).toContain('shell.exec');
  });

  it('emits a block JSON with approval phrasing when require_approval', () => {
    const r = buildHookResponse(
      {
        decision: 'approve',
        reasonCode: 'BOUNDARY_REQUIRES_APPROVAL',
        humanExplanation: 'Inspecting Keychain crosses a boundary.',
      },
      mapped
    );
    expect(r.exit).toBe(0);
    const parsed = JSON.parse(r.stdout!);
    expect(parsed.decision).toBe('block');
    expect(parsed.reason).toContain('requires approval');
  });
});

/**
 * Spin up a tiny HTTP server that mimics Gatekeeper for end-to-end coverage of
 * `evaluate()` and `run()`. We intentionally don't depend on the real server
 * here so this test stays a self-contained unit.
 */
class MockGatekeeper {
  server: Server;
  port = 0;
  lastBody?: Record<string, unknown>;
  lastTool?: string;
  response: unknown = { decision: 'allow' };
  status = 200;

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          this.lastBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          this.lastTool = req.url?.replace(/^\/tool\//, '');
          res.writeHead(this.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(this.response));
        });
      });
      this.server.listen(0, '127.0.0.1', () => {
        this.port = (this.server.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }
}

describe('evaluate (HTTP round-trip)', () => {
  let mock: MockGatekeeper;

  beforeEach(async () => {
    mock = new MockGatekeeper();
    await mock.start();
  });

  afterEach(async () => {
    await mock.stop();
  });

  it('POSTs dryRun=true to /tool/:toolName and returns the decision', async () => {
    mock.response = {
      decision: 'deny',
      reasonCode: 'BOUNDARY_DENIED',
      humanExplanation: 'no',
    };
    const result = await evaluate(
      mock.baseUrl(),
      'shell.exec',
      { command: 'security delete-generic-password' },
      { agentName: 'claude-code', agentRole: 'claude-code', timeoutMs: 2000 }
    );
    expect(result.decision).toBe('deny');
    expect(mock.lastTool).toBe('shell.exec');
    expect(mock.lastBody?.dryRun).toBe(true);
    expect(mock.lastBody?.actor).toMatchObject({ name: 'claude-code', role: 'claude-code' });
  });

  it('throws on non-2xx status', async () => {
    mock.status = 500;
    mock.response = { error: 'oops' };
    await expect(
      evaluate(mock.baseUrl(), 'shell.exec', { command: 'ls' }, {
        agentName: 'a',
        agentRole: 'a',
        timeoutMs: 2000,
      })
    ).rejects.toThrow(/HTTP 500/);
  });
});

describe('run (full hook lifecycle, mocked Gatekeeper)', () => {
  let mock: MockGatekeeper;
  let originalBaseUrl: string | undefined;

  beforeEach(async () => {
    mock = new MockGatekeeper();
    await mock.start();
    originalBaseUrl = process.env.GATEKEEPER_BASE_URL;
    process.env.GATEKEEPER_BASE_URL = mock.baseUrl();
  });

  afterEach(async () => {
    if (originalBaseUrl === undefined) delete process.env.GATEKEEPER_BASE_URL;
    else process.env.GATEKEEPER_BASE_URL = originalBaseUrl;
    await mock.stop();
  });

  it('passes through ungated tools', async () => {
    const result = await run(
      JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/tmp/x' } })
    );
    expect(result.exit).toBe(0);
    expect(result.stdout).toBeUndefined();
  });

  it('Puppeteer escalation step 2: keychain-read returns block JSON to Claude Code', async () => {
    mock.response = {
      decision: 'approve',
      reasonCode: 'BOUNDARY_REQUIRES_APPROVAL',
      humanExplanation: 'Inspecting macOS Keychain entries crosses a sensitive local boundary.',
      remediation:
        'Use a throwaway Chromium profile with --user-data-dir=$(mktemp -d) and --use-mock-keychain instead of inspecting the user\'s Keychain.',
    };
    const result = await run(
      JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'security find-generic-password -s "Chromium Safe Storage"' },
      })
    );
    expect(result.exit).toBe(0);
    const parsed = JSON.parse(result.stdout!);
    expect(parsed.decision).toBe('block');
    expect(parsed.reason).toMatch(/Keychain/);
    expect(parsed.reason).toMatch(/throwaway/);
  });

  it('Puppeteer escalation step 3: keychain-delete returns block JSON', async () => {
    mock.response = {
      decision: 'deny',
      reasonCode: 'BOUNDARY_DENIED',
      humanExplanation: 'Deleting Keychain credentials is destructive.',
    };
    const result = await run(
      JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'security delete-generic-password -s "Chromium Safe Storage"' },
      })
    );
    const parsed = JSON.parse(result.stdout!);
    expect(parsed.decision).toBe('block');
    expect(parsed.reason).toMatch(/destructive/i);
  });

  it('fails open by default when server is unreachable', async () => {
    process.env.GATEKEEPER_BASE_URL = 'http://127.0.0.1:1'; // closed port
    delete process.env.GATEKEEPER_FAIL_CLOSED;
    const result = await run(
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } })
    );
    expect(result.exit).toBe(0);
    expect(result.stdout).toBeUndefined();
  });

  it('fails closed when GATEKEEPER_FAIL_CLOSED is set', async () => {
    process.env.GATEKEEPER_BASE_URL = 'http://127.0.0.1:1';
    process.env.GATEKEEPER_FAIL_CLOSED = '1';
    try {
      const result = await run(
        JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } })
      );
      const parsed = JSON.parse(result.stdout!);
      expect(parsed.decision).toBe('block');
      expect(parsed.reason).toMatch(/unreachable/i);
    } finally {
      delete process.env.GATEKEEPER_FAIL_CLOSED;
    }
  });

  it('passes through bad stdin JSON without blocking', async () => {
    const result = await run('not json');
    expect(result.exit).toBe(0);
    expect(result.stdout).toBeUndefined();
  });
});
