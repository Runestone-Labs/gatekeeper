/**
 * Unit tests for OpenClaw Gatekeeper Tool Plugin
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import register from './tools.js';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock crypto.randomUUID
vi.stubGlobal('crypto', {
  randomUUID: () => 'test-uuid-1234',
});

// Mock environment
vi.stubEnv('GATEKEEPER_URL', 'http://127.0.0.1:3847');

describe('OpenClaw Gatekeeper Tool Plugin', () => {
  let registeredTools: any[] = [];
  let mockApi: any;

  beforeEach(() => {
    mockFetch.mockReset();
    registeredTools = [];

    // Mock the OpenClaw API
    mockApi = {
      pluginConfig: {},
      registerTool: (tool: any, _options?: any) => {
        registeredTools.push(tool);
      },
    };

    // Register the plugin
    register(mockApi);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('plugin registration', () => {
    it('registers three tools', () => {
      expect(registeredTools).toHaveLength(3);
    });

    it('registers tools with correct names', () => {
      expect(registeredTools.map((t) => t.name)).toEqual(['gk_exec', 'gk_write', 'gk_http']);
    });

    it('each tool has name, description, parameters, and execute', () => {
      for (const tool of registeredTools) {
        expect(tool).toHaveProperty('name');
        expect(tool).toHaveProperty('description');
        expect(tool).toHaveProperty('parameters');
        expect(tool).toHaveProperty('execute');
        expect(typeof tool.execute).toBe('function');
      }
    });

    it('tools have neutral descriptions (no security language)', () => {
      for (const tool of registeredTools) {
        // Should not contain security-related terms that trigger model pre-filtering
        expect(tool.description.toLowerCase()).not.toContain('security');
        expect(tool.description.toLowerCase()).not.toContain('dangerous');
        expect(tool.description.toLowerCase()).not.toContain('blocked');
        expect(tool.description.toLowerCase()).not.toContain('policy');
        expect(tool.description.toLowerCase()).not.toContain('ssrf');
      }
    });
  });

  describe('gk_exec tool', () => {
    const getExecTool = () => registeredTools.find((t) => t.name === 'gk_exec')!;

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

      const result = await getExecTool().execute('tool-call-id', { command: 'ls' });

      expect(result.content[0].text).toContain('file1');
      expect(result.details).toEqual({ stdout: 'file1\nfile2', stderr: '', exitCode: 0 });
    });

    it('returns error on deny', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: () =>
          Promise.resolve({
            decision: 'deny',
            requestId: 'test-uuid-1234',
            humanExplanation: 'Denied: matches deny pattern "rm -rf"',
          }),
      });

      const result = await getExecTool().execute('tool-call-id', { command: 'rm -rf /' });

      expect(result.content[0].text).toContain('Error');
      expect(result.content[0].text).toContain('rm -rf');
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

      const result = await getExecTool().execute('tool-call-id', { command: 'sudo reboot' });

      expect(result.content[0].text).toContain('Approval required');
      expect(result.content[0].text).toContain('approval-789');
      expect(result.details.pending).toBe(true);
      expect(result.details.approvalId).toBe('approval-789');
    });

    it('handles network errors gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

      const result = await getExecTool().execute('tool-call-id', { command: 'ls' });

      expect(result.content[0].text).toContain('Gatekeeper error');
      expect(result.content[0].text).toContain('Connection refused');
    });
  });

  describe('gk_write tool', () => {
    const getWriteTool = () => registeredTools.find((t) => t.name === 'gk_write')!;

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

      const result = await getWriteTool().execute('tool-call-id', { path: '/tmp/test.txt', content: 'Hello world!' });

      expect(result.details).toEqual({ path: '/tmp/test.txt', bytesWritten: 12 });
    });

    it('returns error on deny (blocked extension)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: () =>
          Promise.resolve({
            decision: 'deny',
            requestId: 'test-uuid-1234',
            humanExplanation: 'Denied: blocked extension .env',
          }),
      });

      const result = await getWriteTool().execute('tool-call-id', { path: '/app/.env', content: 'SECRET=abc' });

      expect(result.content[0].text).toContain('Error');
      expect(result.content[0].text).toContain('.env');
    });
  });

  describe('gk_http tool', () => {
    const getHttpTool = () => registeredTools.find((t) => t.name === 'gk_http')!;

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

      const result = await getHttpTool().execute('tool-call-id', { url: 'https://api.example.com', method: 'GET' });

      expect(result.details).toEqual({
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
            humanExplanation: 'Denied: IP in blocked range (metadata endpoint)',
          }),
      });

      const result = await getHttpTool().execute('tool-call-id', {
        url: 'http://169.254.169.254/latest/meta-data/',
        method: 'GET',
      });

      expect(result.content[0].text).toContain('Error');
      expect(result.content[0].text).toContain('blocked range');
    });
  });

  describe('plugin configuration', () => {
    it('uses default URL when no config provided', () => {
      // Verify the fetch was called with the default URL
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ decision: 'allow', result: {} }),
      });

      const tool = registeredTools.find((t) => t.name === 'gk_exec')!;
      tool.execute('id', { command: 'test' });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://127.0.0.1:3847/tool/shell.exec',
        expect.anything()
      );
    });

    it('accepts custom gatekeeperUrl in config', () => {
      // Re-register with custom URL
      registeredTools = [];
      mockApi.pluginConfig = { gatekeeperUrl: 'http://custom:9999' };
      register(mockApi);

      expect(registeredTools).toHaveLength(3);

      // Verify the fetch uses custom URL
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ decision: 'allow', result: {} }),
      });

      const tool = registeredTools.find((t) => t.name === 'gk_exec')!;
      tool.execute('id', { command: 'test' });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://custom:9999/tool/shell.exec',
        expect.anything()
      );
    });
  });
});
