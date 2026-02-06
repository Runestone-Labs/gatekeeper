import { promises as dns } from 'node:dns';
import net from 'node:net';
import { ToolResult, ToolPolicy } from '../types.js';
import { HttpRequestArgs } from './schemas.js';
import { isPrivateIP, ipInCIDR, truncate } from '../utils.js';

// Default limits
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024; // 1MB
const DEFAULT_MAX_REDIRECTS = 3;

// Default private IP ranges (SSRF protection)
const DEFAULT_DENY_IP_RANGES = [
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '0.0.0.0/8',
];

// Safe headers to include in response
const SAFE_RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'cache-control',
  'etag',
  'last-modified',
  'date',
  'x-request-id',
];

/**
 * Execute an HTTP request.
 * SECURITY: Validates against SSRF by checking resolved IP addresses.
 */
export async function executeHttpRequest(
  args: HttpRequestArgs,
  policy: ToolPolicy
): Promise<ToolResult> {
  const timeoutMs = policy.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const maxBodyBytes = policy.max_body_bytes ?? DEFAULT_MAX_BODY_BYTES;
  const denyIpRanges = policy.deny_ip_ranges ?? DEFAULT_DENY_IP_RANGES;
  const maxRedirects = policy.max_redirects ?? DEFAULT_MAX_REDIRECTS;

  try {
    // Parse URL
    let currentUrl = new URL(args.url);

    // SECURITY: Resolve hostname and check for private IPs (SSRF protection)
    const initialHostCheck = await validateResolvedHost(currentUrl.hostname, policy, denyIpRanges);
    if (!initialHostCheck.ok) {
      return { success: false, error: initialHostCheck.error };
    }

    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let redirects = 0;
      let method = args.method;
      let body = args.method === 'POST' ? args.body : undefined;

      while (true) {
        const response = await fetch(currentUrl.toString(), {
          method,
          headers: args.headers,
          body,
          signal: controller.signal,
          redirect: 'manual',
        });

        if (isRedirect(response.status)) {
          if (redirects >= maxRedirects) {
            return {
              success: false,
              error: `Denied: exceeded max redirects (${maxRedirects})`,
            };
          }

          const location = response.headers.get('location');
          if (!location) {
            return {
              success: false,
              error: 'Denied: redirect response missing Location header',
            };
          }

          if (method !== 'GET') {
            return {
              success: false,
              error: 'Denied: redirects are only allowed for GET requests',
            };
          }

          const nextUrl = new URL(location, currentUrl);
          const hostCheck = await validateResolvedHost(nextUrl.hostname, policy, denyIpRanges);
          if (!hostCheck.ok) {
            return { success: false, error: hostCheck.error };
          }

          currentUrl = nextUrl;
          redirects += 1;
          continue;
        }

        clearTimeout(timeoutId);

        // Read body with size limit
        const reader = response.body?.getReader();
        if (!reader) {
          return {
            success: true,
            output: {
              status: response.status,
              headers: filterHeaders(response.headers),
              body: '',
            },
          };
        }

        let responseBody = '';
        let totalBytes = 0;
        let truncated = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          totalBytes += value.length;
          if (totalBytes > maxBodyBytes) {
            truncated = true;
            responseBody += new TextDecoder().decode(
              value.slice(0, maxBodyBytes - (totalBytes - value.length))
            );
            reader.cancel();
            break;
          }

          responseBody += new TextDecoder().decode(value);
        }

        return {
          success: response.ok,
          output: {
            status: response.status,
            headers: filterHeaders(response.headers),
            body: truncated ? truncate(responseBody, maxBodyBytes) : responseBody,
            truncated,
          },
        };
      }
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (err) {
    const error = err as Error;

    if (error.name === 'AbortError') {
      return {
        success: false,
        error: `Request timeout (${timeoutMs}ms exceeded)`,
      };
    }

    return {
      success: false,
      error: `Request failed: ${error.message}`,
    };
  }
}

/**
 * Filter response headers to only include safe ones.
 * SECURITY: Prevents leaking sensitive headers in responses.
 */
function filterHeaders(headers: Headers): Record<string, string> {
  const filtered: Record<string, string> = {};

  for (const key of SAFE_RESPONSE_HEADERS) {
    const value = headers.get(key);
    if (value) {
      filtered[key] = value;
    }
  }

  return filtered;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function validateResolvedHost(
  hostname: string,
  policy: ToolPolicy,
  denyIpRanges: string[]
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Domain allowlist/denylist checks
  if (policy.allowed_domains && policy.allowed_domains.length > 0) {
    const allowed = policy.allowed_domains.some((domain) => matchesDomain(hostname, domain));
    if (!allowed) {
      return { ok: false, error: `Denied: domain "${hostname}" not in allowlist` };
    }
  }

  if (policy.deny_domains && policy.deny_domains.length > 0) {
    if (policy.deny_domains.some((domain) => matchesDomain(hostname, domain))) {
      return { ok: false, error: `Denied: domain "${hostname}" is blocked` };
    }
  }

  try {
    const addresses: string[] = [];

    try {
      addresses.push(...(await dns.resolve4(hostname)));
    } catch {
      // Ignore IPv4 resolution errors
    }

    try {
      addresses.push(...(await dns.resolve6(hostname)));
    } catch {
      // Ignore IPv6 resolution errors
    }

    if (addresses.length === 0) {
      throw new Error('DNS resolution failed');
    }

    for (const ip of addresses) {
      if (isPrivateIP(ip)) {
        return { ok: false, error: `Denied: hostname "${hostname}" resolves to private IP` };
      }

      for (const cidr of denyIpRanges) {
        if (ipInCIDR(ip, cidr)) {
          return {
            ok: false,
            error: `Denied: hostname "${hostname}" resolves to blocked IP range`,
          };
        }
      }
    }
  } catch (_dnsErr) {
    if (net.isIP(hostname) && isPrivateIP(hostname)) {
      return { ok: false, error: `Denied: direct IP "${hostname}" is in private range` };
    }
  }

  return { ok: true };
}

function matchesDomain(hostname: string, domain: string): boolean {
  const normalizedHost = hostname.toLowerCase();
  const normalizedDomain = domain.toLowerCase();

  if (normalizedDomain.startsWith('*.')) {
    const suffix = normalizedDomain.slice(1);
    return normalizedHost.endsWith(suffix) && normalizedHost !== normalizedDomain.slice(2);
  }

  if (normalizedDomain.startsWith('.')) {
    const suffix = normalizedDomain;
    return normalizedHost === normalizedDomain.slice(1) || normalizedHost.endsWith(suffix);
  }

  return normalizedHost === normalizedDomain;
}
