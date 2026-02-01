import { promises as dns } from 'node:dns';
import { ToolResult, ToolPolicy } from '../types.js';
import { HttpRequestArgs } from './schemas.js';
import { isPrivateIP, ipInCIDR, truncate } from '../utils.js';

// Default limits
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024; // 1MB

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

  try {
    // Parse URL
    const url = new URL(args.url);
    const hostname = url.hostname;

    // SECURITY: Resolve hostname and check for private IPs (SSRF protection)
    try {
      const addresses = await dns.resolve4(hostname);

      for (const ip of addresses) {
        // Check if IP is private
        if (isPrivateIP(ip)) {
          return {
            success: false,
            error: `Denied: hostname "${hostname}" resolves to private IP`,
          };
        }

        // Check against deny_ip_ranges
        for (const cidr of denyIpRanges) {
          if (ipInCIDR(ip, cidr)) {
            return {
              success: false,
              error: `Denied: hostname "${hostname}" resolves to blocked IP range`,
            };
          }
        }
      }
    } catch (dnsErr) {
      // If DNS fails, allow the request to proceed (might be a direct IP)
      // But check if it's a private IP first
      if (isPrivateIP(hostname)) {
        return {
          success: false,
          error: `Denied: direct IP "${hostname}" is in private range`,
        };
      }
    }

    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // Make the request
      const response = await fetch(args.url, {
        method: args.method,
        headers: args.headers,
        body: args.method === 'POST' ? args.body : undefined,
        signal: controller.signal,
      });

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

      let body = '';
      let totalBytes = 0;
      let truncated = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        totalBytes += value.length;
        if (totalBytes > maxBodyBytes) {
          truncated = true;
          body += new TextDecoder().decode(value.slice(0, maxBodyBytes - (totalBytes - value.length)));
          reader.cancel();
          break;
        }

        body += new TextDecoder().decode(value);
      }

      return {
        success: response.ok,
        output: {
          status: response.status,
          headers: filterHeaders(response.headers),
          body: truncated ? truncate(body, maxBodyBytes) : body,
          truncated,
        },
      };
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
