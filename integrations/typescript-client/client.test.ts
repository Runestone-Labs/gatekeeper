/**
 * Unit tests for Gatekeeper TypeScript Client
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GatekeeperClient } from './client.js';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock crypto.randomUUID
vi.stubGlobal('crypto', {
  randomUUID: () => 'test-uuid-1234',
});

describe('GatekeeperClient', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('accepts string URL', () => {
      const client = new GatekeeperClient('http://localhost:3847');
      expect(client).toBeDefined();
    });

    it('accepts config object', () => {
      const client = new GatekeeperClient({
        baseUrl: 'http://localhost:3847',
        agentName: 'test-agent',
        runId: 'run-123',
      });
      expect(client).toBeDefined();
    });
  });

  describe('callTool', () => {
    it('sends correct request format', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ decision: 'allow', requestId: 'test-uuid-1234' }),
      });

      const client = new GatekeeperClient({
        baseUrl: 'http://localhost:3847',
        agentName: 'test-agent',
      });

      await client.callTool('shell.exec', { command: 'ls' });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3847/tool/shell.exec',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toEqual({
        requestId: 'test-uuid-1234',
        actor: { type: 'agent', name: 'test-agent' },
        args: { command: 'ls' },
      });
    });

    it('includes runId when configured', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ decision: 'allow' }),
      });

      const client = new GatekeeperClient({
        baseUrl: 'http://localhost:3847',
        agentName: 'test-agent',
        runId: 'run-456',
      });

      await client.callTool('shell.exec', { command: 'ls' });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.actor.runId).toBe('run-456');
    });

    it('handles allow response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            decision: 'allow',
            requestId: 'test-uuid-1234',
            result: { stdout: 'hello', stderr: '', exitCode: 0 },
          }),
      });

      const client = new GatekeeperClient('http://localhost:3847');
      const result = await client.callTool('shell.exec', { command: 'echo hello' });

      expect(result.decision).toBe('allow');
      expect(result.result).toEqual({ stdout: 'hello', stderr: '', exitCode: 0 });
    });

    it('handles approve response (202)', async () => {
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

      const client = new GatekeeperClient('http://localhost:3847');
      const result = await client.callTool('shell.exec', { command: 'sudo rm' });

      expect(result.decision).toBe('approve');
      expect(result.approvalId).toBe('approval-789');
      expect(result.expiresAt).toBe('2024-01-01T12:00:00Z');
    });

    it('handles deny response (403)', async () => {
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

      const client = new GatekeeperClient('http://localhost:3847');
      const result = await client.callTool('shell.exec', { command: 'rm -rf /' });

      expect(result.decision).toBe('deny');
      expect(result.reason).toContain('rm -rf');
    });

    it('throws on unexpected HTTP errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      const client = new GatekeeperClient('http://localhost:3847');

      await expect(client.callTool('shell.exec', { command: 'ls' })).rejects.toThrow(
        'Gatekeeper request failed: 500 Internal Server Error'
      );
    });
  });

  describe('convenience methods', () => {
    it('shellExec calls correct tool', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ decision: 'allow' }),
      });

      const client = new GatekeeperClient('http://localhost:3847');
      await client.shellExec({ command: 'ls -la', cwd: '/tmp' });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3847/tool/shell.exec',
        expect.any(Object)
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.args).toEqual({ command: 'ls -la', cwd: '/tmp' });
    });

    it('filesWrite calls correct tool', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ decision: 'allow' }),
      });

      const client = new GatekeeperClient('http://localhost:3847');
      await client.filesWrite({ path: '/tmp/test.txt', content: 'hello' });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3847/tool/files.write',
        expect.any(Object)
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.args).toEqual({ path: '/tmp/test.txt', content: 'hello' });
    });

    it('httpRequest calls correct tool', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ decision: 'allow' }),
      });

      const client = new GatekeeperClient('http://localhost:3847');
      await client.httpRequest({
        url: 'https://example.com',
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3847/tool/http.request',
        expect.any(Object)
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.args).toEqual({
        url: 'https://example.com',
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });
    });
  });

  describe('health', () => {
    it('returns health status', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            version: '0.1.0',
            policyHash: 'sha256:abc123',
            uptime: 100,
            pendingApprovals: 0,
            demoMode: true,
          }),
      });

      const client = new GatekeeperClient('http://localhost:3847');
      const health = await client.health();

      expect(health.version).toBe('0.1.0');
      expect(health.demoMode).toBe(true);
    });

    it('throws on health check failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
      });

      const client = new GatekeeperClient('http://localhost:3847');

      await expect(client.health()).rejects.toThrow('Health check failed: 503');
    });
  });
});
