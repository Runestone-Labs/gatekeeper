import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ToolPolicy } from '../../src/types.js';

/**
 * SSRF redirect regression tests.
 *
 * Validates that Gatekeeper re-checks resolved IP addresses after
 * following HTTP redirects. Without this, an attacker could host
 * a public URL that 302-redirects to an internal IP (e.g. cloud
 * metadata at 169.254.169.254), bypassing the initial DNS check.
 *
 * We mock fetch and DNS to simulate redirect scenarios without
 * needing real network access.
 */

// Mock dns module to control IP resolution
vi.mock('node:dns', () => ({
  promises: {
    resolve4: vi.fn(),
    resolve6: vi.fn(),
  },
}));

// Mock global fetch to simulate redirects
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('SSRF redirect protection', () => {
  let dns: { promises: { resolve4: ReturnType<typeof vi.fn>; resolve6: ReturnType<typeof vi.fn> } };

  beforeEach(async () => {
    vi.resetModules();
    mockFetch.mockReset();

    dns = (await import('node:dns')) as unknown as typeof dns;
    // Default: resolve6 always fails (simplifies tests)
    dns.promises.resolve6.mockRejectedValue(new Error('no AAAA'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const policy: ToolPolicy = {
    decision: 'allow',
    deny_ip_ranges: [
      '10.0.0.0/8',
      '172.16.0.0/12',
      '192.168.0.0/16',
      '169.254.0.0/16',
      '127.0.0.0/8',
    ],
    max_redirects: 3,
    timeout_ms: 5000,
  };

  async function runHttpRequest(args: { url: string; method: string; body?: string }) {
    // Re-import to get mocked dependencies
    const { executeHttpRequest } = await import('../../src/tools/httpRequest.js');
    return executeHttpRequest(args, policy);
  }

  it('blocks redirect from public IP to cloud metadata (169.254.169.254)', async () => {
    // Initial host resolves to a public IP — passes
    dns.promises.resolve4.mockImplementation((hostname: string) => {
      if (hostname === 'attacker.com') return Promise.resolve(['93.184.216.34']);
      if (hostname === '169.254.169.254') return Promise.resolve(['169.254.169.254']);
      return Promise.reject(new Error('ENOTFOUND'));
    });

    // First fetch returns a redirect to cloud metadata
    mockFetch.mockResolvedValueOnce({
      status: 302,
      headers: new Headers({ location: 'http://169.254.169.254/latest/meta-data/' }),
    });

    const result = await runHttpRequest({
      url: 'http://attacker.com/redirect',
      method: 'GET',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/blocked IP range|private IP/i);
    // Fetch should have been called once (the initial request),
    // but the redirect target should be blocked before a second fetch
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('blocks redirect from public IP to private network (10.x.x.x)', async () => {
    dns.promises.resolve4.mockImplementation((hostname: string) => {
      if (hostname === 'attacker.com') return Promise.resolve(['93.184.216.34']);
      if (hostname === '10.0.0.1') return Promise.resolve(['10.0.0.1']);
      return Promise.reject(new Error('ENOTFOUND'));
    });

    mockFetch.mockResolvedValueOnce({
      status: 302,
      headers: new Headers({ location: 'http://10.0.0.1/admin' }),
    });

    const result = await runHttpRequest({
      url: 'http://attacker.com/redirect',
      method: 'GET',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/blocked IP range|private IP/i);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('blocks chained redirect: public -> public -> private', async () => {
    dns.promises.resolve4.mockImplementation((hostname: string) => {
      if (hostname === 'attacker.com') return Promise.resolve(['93.184.216.34']);
      if (hostname === 'hop.attacker.com') return Promise.resolve(['93.184.216.35']);
      if (hostname === '192.168.1.1') return Promise.resolve(['192.168.1.1']);
      return Promise.reject(new Error('ENOTFOUND'));
    });

    // First hop: public -> public
    mockFetch.mockResolvedValueOnce({
      status: 301,
      headers: new Headers({ location: 'http://hop.attacker.com/step2' }),
    });

    // Second hop: public -> private
    mockFetch.mockResolvedValueOnce({
      status: 302,
      headers: new Headers({ location: 'http://192.168.1.1/internal' }),
    });

    const result = await runHttpRequest({
      url: 'http://attacker.com/redirect',
      method: 'GET',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/blocked IP range|private IP/i);
    // Two fetches: initial + first hop, then blocked at second hop
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('allows redirect between public IPs', async () => {
    dns.promises.resolve4.mockImplementation((hostname: string) => {
      if (hostname === 'site-a.com') return Promise.resolve(['93.184.216.34']);
      if (hostname === 'site-b.com') return Promise.resolve(['93.184.216.35']);
      return Promise.reject(new Error('ENOTFOUND'));
    });

    // Redirect to another public site
    mockFetch.mockResolvedValueOnce({
      status: 302,
      headers: new Headers({ location: 'http://site-b.com/destination' }),
    });

    // Final destination returns content
    const bodyStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"ok":true}'));
        controller.close();
      },
    });

    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: bodyStream,
    });

    const result = await runHttpRequest({
      url: 'http://site-a.com/go',
      method: 'GET',
    });

    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('enforces max redirects limit', async () => {
    dns.promises.resolve4.mockResolvedValue(['93.184.216.34']);

    // Create a chain of redirects that exceeds the limit
    for (let i = 0; i < 4; i++) {
      mockFetch.mockResolvedValueOnce({
        status: 302,
        headers: new Headers({ location: `http://hop${i}.com/next` }),
      });
    }

    const result = await runHttpRequest({
      url: 'http://start.com/redirect',
      method: 'GET',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/max redirects/i);
  });

  it('blocks redirect for non-GET methods', async () => {
    dns.promises.resolve4.mockResolvedValue(['93.184.216.34']);

    mockFetch.mockResolvedValueOnce({
      status: 302,
      headers: new Headers({ location: 'http://other.com/endpoint' }),
    });

    const result = await runHttpRequest({
      url: 'http://start.com/api',
      method: 'POST',
      body: '{}',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/only allowed for GET/i);
  });

  it('blocks DNS rebinding (hostname resolves to different IPs on retry)', async () => {
    let callCount = 0;
    dns.promises.resolve4.mockImplementation((hostname: string) => {
      if (hostname === 'rebind.attacker.com') {
        callCount++;
        // First resolution returns public IP, subsequent returns private
        if (callCount === 1) return Promise.resolve(['93.184.216.34']);
        return Promise.resolve(['169.254.169.254']);
      }
      return Promise.reject(new Error('ENOTFOUND'));
    });

    // Server redirects back to itself (same hostname, different DNS result)
    mockFetch.mockResolvedValueOnce({
      status: 302,
      headers: new Headers({ location: 'http://rebind.attacker.com/metadata' }),
    });

    const result = await runHttpRequest({
      url: 'http://rebind.attacker.com/start',
      method: 'GET',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/blocked IP range|private IP/i);
  });
});
