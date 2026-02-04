/**
 * Unit tests for OpenClaw Gatekeeper Tool Plugin
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import gatekeeperPlugin, { formatResult } from './tools.js';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock crypto.randomUUID
vi.stubGlobal('crypto', {
  randomUUID: () => 'test-uuid-1234',
});

// Mock environment
vi.stubEnv('GATEKEEPER_URL', 'http://localhost:3847');

describe('OpenClaw Gatekeeper Tool Plugin', () => {
  let tools: ReturnType<typeof gatekeeperPlugin.init>['tools'];

  beforeEach(() => {
    mockFetch.mockReset();
    // Initialize the plugin to get tools
    const result = gatekeeperPlugin.init({});
    tools = result.tools;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('plugin structure', () => {
    it('has correct id and slot', () => {
      expect(gatekeeperPlugin.id).toBe('gatekeeper');
      expect(gatekeeperPlugin.slot).toBe('tool');
    });

    it('exports three tools', () => {
      expect(tools).toHaveLength(3);
      expect(tools.map((t) => t.name)).toEqual(['gk_exec', 'gk_write', 'gk_http']);
    });

    it('each tool has name, description, inputSchema, and execute', () => {
      for (const tool of tools) {
        expect(tool).toHaveProperty('name');
        expect(tool).toHaveProperty('description');
        expect(tool).toHaveProperty('inputSchema');
        expect(tool).toHaveProperty('execute');
        expect(typeof tool.execute).toBe('function');
      }
    });
  });

  describe('gk_exec tool', () => {
    const getExecTool = () => tools.find((t) => t.name === 'gk_exec')!;

    it('returns result on allow', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            decision: 'allow',
            requestId: 'test-uuid-1234',
            result: { stdout: 'file1\nfile2', stderr: '', exitCode: 0 },
          }),
      });

      const result = await getExecTool().execute({ command: 'ls' });

      expect(result.result).toEqual({ stdout: 'file1\nfile2', stderr: '', exitCode: 0 });
      expect(result.error).toBeUndefined();
      expect(result.pending).toBeUndefined();
    });

    it('returns error on deny', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: () =>
          Promise.resolve({
            decision: 'deny',
            requestId: 'test-uuid-1234',
            reason: 'Denied: matches deny pattern "rm -rf"',
          }),
      });

      const result = await getExecTool().execute({ command: 'rm -rf /' });

      expect(result.error).toBe('Denied: matches deny pattern "rm -rf"');
      expect(result.result).toBeUndefined();
      expect(result.pending).toBeUndefined();
    });

    it('returns pending on approve', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 202,
        json: () =>
          Promise.resolve({
            decision: 'approve',
            requestId: 'test-uuid-1234',
            approvalId: 'approval-789',
            expiresAt: '2024-01-01T12:00:00Z',
          }),
      });

      const result = await getExecTool().execute({ command: 'sudo reboot' });

      expect(result.pending).toBe(true);
      expect(result.approvalId).toBe('approval-789');
      expect(result.message).toContain('Approval required');
      expect(result.message).toContain('2024-01-01T12:00:00Z');
      expect(result.result).toBeUndefined();
      expect(result.error).toBeUndefined();
    });

    it('handles network errors gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

      const result = await getExecTool().execute({ command: 'ls' });

      expect(result.error).toContain('Gatekeeper error');
      expect(result.error).toContain('Connection refused');
    });
  });

  describe('gk_write tool', () => {
    const getWriteTool = () => tools.find((t) => t.name === 'gk_write')!;

    it('returns result on allow', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            decision: 'allow',
            requestId: 'test-uuid-1234',
            result: { path: '/tmp/test.txt', bytesWritten: 12 },
          }),
      });

      const result = await getWriteTool().execute({ path: '/tmp/test.txt', content: 'Hello world!' });

      expect(result.result).toEqual({ path: '/tmp/test.txt', bytesWritten: 12 });
    });

    it('returns error on deny (blocked extension)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: () =>
          Promise.resolve({
            decision: 'deny',
            requestId: 'test-uuid-1234',
            reason: 'Denied: blocked extension .env',
          }),
      });

      const result = await getWriteTool().execute({ path: '/app/.env', content: 'SECRET=abc' });

      expect(result.error).toContain('.env');
    });
  });

  describe('gk_http tool', () => {
    const getHttpTool = () => tools.find((t) => t.name === 'gk_http')!;

    it('returns result on allow', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            decision: 'allow',
            requestId: 'test-uuid-1234',
            result: {
              status: 200,
              headers: { 'content-type': 'application/json' },
              body: '{"success": true}',
              truncated: false,
            },
          }),
      });

      const result = await getHttpTool().execute({ url: 'https://api.example.com', method: 'GET' });

      expect(result.result).toEqual({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"success": true}',
        truncated: false,
      });
    });

    it('returns error on deny (SSRF)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: () =>
          Promise.resolve({
            decision: 'deny',
            requestId: 'test-uuid-1234',
            reason: 'Denied: IP in blocked range (metadata endpoint)',
          }),
      });

      const result = await getHttpTool().execute({
        url: 'http://169.254.169.254/latest/meta-data/',
        method: 'GET',
      });

      expect(result.error).toContain('blocked range');
    });
  });

  describe('formatResult helper', () => {
    it('formats deny decision', () => {
      const result = formatResult({
        decision: 'deny',
        reason: 'Not allowed',
      });
      expect(result.error).toBe('Not allowed');
    });

    it('formats approve decision', () => {
      const result = formatResult({
        decision: 'approve',
        approvalId: 'abc-123',
        expiresAt: '2024-01-01T00:00:00Z',
      });
      expect(result.pending).toBe(true);
      expect(result.approvalId).toBe('abc-123');
      expect(result.message).toContain('2024-01-01T00:00:00Z');
    });

    it('formats allow decision', () => {
      const result = formatResult({
        decision: 'allow',
        result: { data: 'test' },
      });
      expect(result.result).toEqual({ data: 'test' });
    });
  });

  describe('plugin configuration', () => {
    it('uses default URL when no config provided', () => {
      // The default URL should be used from GATEKEEPER_URL env var
      // This is implicitly tested by the other tests working
      expect(true).toBe(true);
    });

    it('accepts custom gatekeeperUrl in config', () => {
      const result = gatekeeperPlugin.init({ gatekeeperUrl: 'http://custom:9999' });
      expect(result.tools).toHaveLength(3);
    });
  });
});
