import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';

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
 * Resolve a path to an absolute, normalized path.
 */
export function resolvePath(value: string): string {
  return path.resolve(value);
}

/**
 * Check whether a candidate path is within a base path.
 * Inputs should be resolved paths for consistent behavior.
 */
export function isPathWithin(candidate: string, base: string): boolean {
  const relative = path.relative(base, candidate);
  if (relative === '') return true;
  if (relative === '..') return false;
  return !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Check if an IP address is in a private/internal range.
 * SECURITY: Used for SSRF protection.
 */
export function isPrivateIP(ip: string): boolean {
  const parsed = parseIP(ip);
  if (!parsed) {
    return true;
  }

  if (parsed.kind === 4) {
    return isPrivateIPv4(parsed.value);
  }

  if (parsed.isIpv4Mapped) {
    return isPrivateIPv4(parsed.ipv4Value);
  }

  return isPrivateIPv6(parsed.value);
}

/**
 * Check if a CIDR range contains an IP.
 */
export function ipInCIDR(ip: string, cidr: string): boolean {
  const [range, bits] = cidr.split('/');
  const maskBits = parseInt(bits, 10);

  if (Number.isNaN(maskBits)) return false;

  const ipParsed = parseIP(ip);
  const rangeParsed = parseIP(range);

  if (!ipParsed || !rangeParsed) return false;

  const ipComparable = coerceIpv4Mapped(ipParsed, rangeParsed.kind);
  const rangeComparable = coerceIpv4Mapped(rangeParsed, ipComparable.kind);

  if (ipComparable.kind !== rangeComparable.kind) return false;

  const totalBits = ipComparable.kind === 4 ? 32 : 128;
  if (maskBits < 0 || maskBits > totalBits) return false;

  return matchesCidr(ipComparable.value, rangeComparable.value, maskBits, totalBits);
}

type ParsedIP =
  | { kind: 4; value: bigint; isIpv4Mapped: false }
  | { kind: 6; value: bigint; isIpv4Mapped: boolean; ipv4Value: bigint };

function parseIP(ip: string): ParsedIP | null {
  const ipType = net.isIP(ip);

  if (ipType === 4) {
    const value = parseIPv4(ip);
    if (value === null) return null;
    return { kind: 4, value, isIpv4Mapped: false };
  }

  if (ipType === 6) {
    const parsed = parseIPv6(ip);
    if (!parsed) return null;
    const ipv4Mapped = isIpv4Mapped(parsed.parts);
    const ipv4Value = ipv4Mapped ? ipv4FromParts(parsed.parts) : 0n;
    return {
      kind: 6,
      value: parsed.value,
      isIpv4Mapped: ipv4Mapped,
      ipv4Value,
    };
  }

  return null;
}

function parseIPv4(ip: string): bigint | null {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return null;
  }

  let value = 0n;
  for (const part of parts) {
    value = (value << 8n) + BigInt(part);
  }
  return value;
}

function parseIPv6(ip: string): { value: bigint; parts: number[] } | null {
  const zoneIndex = ip.indexOf('%');
  const sanitized = zoneIndex === -1 ? ip : ip.slice(0, zoneIndex);

  let normalized = sanitized;

  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':');
    if (lastColon === -1) return null;
    const ipv4Part = normalized.slice(lastColon + 1);
    const ipv4Value = parseIPv4(ipv4Part);
    if (ipv4Value === null) return null;
    const high = Number((ipv4Value >> 16n) & 0xffffn);
    const low = Number(ipv4Value & 0xffffn);
    normalized = `${normalized.slice(0, lastColon)}:${high.toString(16)}:${low.toString(16)}`;
  }

  const doubleColonIndex = normalized.indexOf('::');
  let parts: string[] = [];

  if (doubleColonIndex !== -1) {
    const [left, right] = normalized.split('::');
    const leftParts = left ? left.split(':').filter(Boolean) : [];
    const rightParts = right ? right.split(':').filter(Boolean) : [];
    const missing = 8 - (leftParts.length + rightParts.length);
    if (missing < 0) return null;
    parts = [...leftParts, ...Array(missing).fill('0'), ...rightParts];
  } else {
    parts = normalized.split(':');
    if (parts.length !== 8) return null;
  }

  if (parts.length !== 8) return null;

  const hextets: number[] = [];
  for (const part of parts) {
    if (part.length === 0) return null;
    const value = parseInt(part, 16);
    if (Number.isNaN(value) || value < 0 || value > 0xffff) return null;
    hextets.push(value);
  }

  let value = 0n;
  for (const part of hextets) {
    value = (value << 16n) + BigInt(part);
  }

  return { value, parts: hextets };
}

function isPrivateIPv4(value: bigint): boolean {
  const a = Number((value >> 24n) & 0xffn);
  const b = Number((value >> 16n) & 0xffn);

  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 0) return true;

  return false;
}

function isPrivateIPv6(value: bigint): boolean {
  if (value === 0n) return true; // ::
  if (value === 1n) return true; // ::1

  const linkLocalBase = 0xfe80n << 112n; // fe80::/10
  if (matchesCidr(value, linkLocalBase, 10, 128)) return true;

  const uniqueLocalBase = 0xfc00n << 112n; // fc00::/7
  if (matchesCidr(value, uniqueLocalBase, 7, 128)) return true;

  return false;
}

function isIpv4Mapped(parts: number[]): boolean {
  return (
    parts[0] === 0 &&
    parts[1] === 0 &&
    parts[2] === 0 &&
    parts[3] === 0 &&
    parts[4] === 0 &&
    parts[5] === 0xffff
  );
}

function ipv4FromParts(parts: number[]): bigint {
  return (BigInt(parts[6]) << 16n) + BigInt(parts[7]);
}

function coerceIpv4Mapped(parsed: ParsedIP, targetKind: 4 | 6): ParsedIP {
  if (targetKind === 4 && parsed.kind === 6 && parsed.isIpv4Mapped) {
    return { kind: 4, value: parsed.ipv4Value, isIpv4Mapped: false };
  }
  return parsed;
}

function matchesCidr(
  value: bigint,
  range: bigint,
  maskBits: number,
  totalBits: number
): boolean {
  if (maskBits === 0) return true;

  const shift = BigInt(totalBits - maskBits);
  return (value >> shift) === (range >> shift);
}
