/**
 * Unit tests for OpenClaw Gatekeeper Skill Tools
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { gk_exec, gk_write, gk_http } from './tools.js';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock crypto.randomUUID
vi.stubGlobal('crypto', {
  randomUUID: () => 'test-uuid-1234',
});

// Mock environment
vi.stubEnv('GATEKEEPER_URL', 'http://localhost:3847');

describe('OpenClaw Gatekeeper Tools', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('gk_exec', () => {
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

      const result = await gk_exec({ command: 'ls' });

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

      const result = await gk_exec({ command: 'rm -rf /' });

      expect(result.error).toBe('Denied: Denied: matches deny pattern "rm -rf"');
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

      const result = await gk_exec({ command: 'sudo reboot' });

      expect(result.pending).toBe(true);
      expect(result.approvalId).toBe('approval-789');
      expect(result.message).toContain('Approval required');
      expect(result.message).toContain('2024-01-01T12:00:00Z');
      expect(result.result).toBeUndefined();
      expect(result.error).toBeUndefined();
    });
  });

  describe('gk_write', () => {
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

      const result = await gk_write({ path: '/tmp/test.txt', content: 'Hello world!' });

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

      const result = await gk_write({ path: '/app/.env', content: 'SECRET=abc' });

      expect(result.error).toContain('.env');
    });
  });

  describe('gk_http', () => {
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

      const result = await gk_http({ url: 'https://api.example.com', method: 'GET' });

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

      const result = await gk_http({
        url: 'http://169.254.169.254/latest/meta-data/',
        method: 'GET',
      });

      expect(result.error).toContain('blocked range');
    });
  });
});
