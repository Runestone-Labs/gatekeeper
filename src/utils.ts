import crypto from 'node:crypto';

/**
 * Stable JSON stringify with sorted keys for deterministic hashing.
 * SECURITY: Used for signing approval payloads to prevent parameter tampering.
 */
export function canonicalize(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }

  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalize).join(',') + ']';
  }

  const sortedKeys = Object.keys(obj as Record<string, unknown>).sort();
  const pairs = sortedKeys.map((key) => {
    const value = (obj as Record<string, unknown>)[key];
    return JSON.stringify(key) + ':' + canonicalize(value);
  });
  return '{' + pairs.join(',') + '}';
}

/**
 * Compute SHA-256 hash of a string, returning hex-encoded result.
 */
export function computeHash(data: string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Compute HMAC-SHA256 signature.
 * SECURITY: Used for signing approval URLs.
 */
export function computeHmac(data: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

/**
 * Generate a unique request ID.
 */
export function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Redact sensitive values from args for logging.
 * SECURITY: Prevents secrets from appearing in audit logs.
 */
export function redactSecrets(obj: unknown, maxLength = 200): string {
  const sensitivePatterns = [
    /password/i,
    /secret/i,
    /token/i,
    /api[_-]?key/i,
    /auth/i,
    /credential/i,
    /bearer/i,
  ];

  function redact(value: unknown, key?: string): unknown {
    if (key && sensitivePatterns.some((p) => p.test(key))) {
      return '[REDACTED]';
    }

    if (typeof value === 'string') {
      // Redact anything that looks like a token or key
      if (/^(sk-|pk-|xox[pboa]-|ghp_|gho_|Bearer\s)/i.test(value)) {
        return '[REDACTED]';
      }
      // Truncate long strings
      if (value.length > maxLength) {
        return value.slice(0, maxLength) + `...[truncated ${value.length - maxLength} chars]`;
      }
      return value;
    }

    if (Array.isArray(value)) {
      return value.slice(0, 10).map((v) => redact(v));
    }

    if (value !== null && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        result[k] = redact(v, k);
      }
      return result;
    }

    return value;
  }

  return JSON.stringify(redact(obj));
}

/**
 * Truncate a string to a maximum length.
 */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength) + `...[truncated ${str.length - maxLength} chars]`;
}

/**
 * Check if an IP address is in a private/internal range.
 * SECURITY: Used for SSRF protection.
 */
export function isPrivateIP(ip: string): boolean {
  // Parse IP into parts
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    // Not a valid IPv4, treat as potentially dangerous
    return true;
  }

  const [a, b] = parts;

  // 127.0.0.0/8 - Loopback
  if (a === 127) return true;

  // 10.0.0.0/8 - Private
  if (a === 10) return true;

  // 172.16.0.0/12 - Private
  if (a === 172 && b >= 16 && b <= 31) return true;

  // 192.168.0.0/16 - Private
  if (a === 192 && b === 168) return true;

  // 169.254.0.0/16 - Link-local / Cloud metadata
  if (a === 169 && b === 254) return true;

  // 0.0.0.0/8 - Current network
  if (a === 0) return true;

  return false;
}

/**
 * Check if a CIDR range contains an IP.
 */
export function ipInCIDR(ip: string, cidr: string): boolean {
  const [range, bits] = cidr.split('/');
  const mask = parseInt(bits, 10);

  const ipNum = ipToNumber(ip);
  const rangeNum = ipToNumber(range);

  if (ipNum === null || rangeNum === null) return false;

  const maskNum = ~(Math.pow(2, 32 - mask) - 1) >>> 0;
  return (ipNum & maskNum) === (rangeNum & maskNum);
}

function ipToNumber(ip: string): number | null {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return null;
  }
  return (parts[0] << 24) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}
