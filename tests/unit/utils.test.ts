import { describe, it, expect } from 'vitest';
import {
  canonicalize,
  computeHash,
  computeHmac,
  generateId,
  redactSecrets,
  truncate,
  isPrivateIP,
  ipInCIDR,
} from '../../src/utils.js';

describe('canonicalize', () => {
  it('sorts object keys alphabetically', () => {
    const obj = { b: 1, a: 2, c: 3 };
    expect(canonicalize(obj)).toBe('{"a":2,"b":1,"c":3}');
  });

  it('handles nested objects', () => {
    const obj = { z: { b: 1, a: 2 }, a: 1 };
    expect(canonicalize(obj)).toBe('{"a":1,"z":{"a":2,"b":1}}');
  });

  it('preserves array order but sorts nested objects', () => {
    const obj = {
      arr: [
        { b: 1, a: 2 },
        { d: 3, c: 4 },
      ],
    };
    expect(canonicalize(obj)).toBe('{"arr":[{"a":2,"b":1},{"c":4,"d":3}]}');
  });

  it('handles primitives', () => {
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize(123)).toBe('123');
    expect(canonicalize('hello')).toBe('"hello"');
    expect(canonicalize(true)).toBe('true');
  });

  it('produces consistent output for equivalent objects', () => {
    const obj1 = { command: 'ls', cwd: '/tmp' };
    const obj2 = { cwd: '/tmp', command: 'ls' };
    expect(canonicalize(obj1)).toBe(canonicalize(obj2));
  });
});

describe('computeHash', () => {
  it('returns consistent SHA-256 hash', () => {
    const hash1 = computeHash('test');
    const hash2 = computeHash('test');
    expect(hash1).toBe(hash2);
  });

  it('returns different hash for different inputs', () => {
    const hash1 = computeHash('test1');
    const hash2 = computeHash('test2');
    expect(hash1).not.toBe(hash2);
  });

  it('returns hex-encoded string', () => {
    const hash = computeHash('test');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('handles empty string', () => {
    const hash = computeHash('');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('computeHmac', () => {
  it('returns consistent HMAC for same input and secret', () => {
    const sig1 = computeHmac('data', 'secret');
    const sig2 = computeHmac('data', 'secret');
    expect(sig1).toBe(sig2);
  });

  it('returns different HMAC for different data', () => {
    const sig1 = computeHmac('data1', 'secret');
    const sig2 = computeHmac('data2', 'secret');
    expect(sig1).not.toBe(sig2);
  });

  it('returns different HMAC for different secret', () => {
    const sig1 = computeHmac('data', 'secret1');
    const sig2 = computeHmac('data', 'secret2');
    expect(sig1).not.toBe(sig2);
  });

  it('returns hex-encoded string', () => {
    const sig = computeHmac('data', 'secret');
    expect(sig).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('generateId', () => {
  it('returns a valid UUID', () => {
    const id = generateId();
    expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  });

  it('returns unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });
});

describe('redactSecrets', () => {
  it('redacts password fields', () => {
    const result = redactSecrets({ password: 'secret123' });
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('secret123');
  });

  it('redacts token fields', () => {
    const result = redactSecrets({ token: 'abc123' });
    expect(result).toContain('[REDACTED]');
  });

  it('redacts API key fields', () => {
    const result = redactSecrets({ apiKey: 'key123', api_key: 'key456' });
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('key123');
  });

  it('redacts Bearer tokens in values', () => {
    const result = redactSecrets({ header: 'Bearer xyz123' });
    expect(result).toContain('[REDACTED]');
  });

  it('redacts sk- prefixed values (OpenAI keys)', () => {
    const result = redactSecrets({ key: 'sk-abc123' });
    expect(result).toContain('[REDACTED]');
  });

  it('truncates long strings', () => {
    const longString = 'a'.repeat(300);
    const result = redactSecrets({ data: longString }, 100);
    expect(result).toContain('truncated');
    expect(result).not.toContain(longString);
  });

  it('preserves non-sensitive data', () => {
    const result = redactSecrets({ name: 'test', count: 42 });
    expect(result).toContain('test');
    expect(result).toContain('42');
  });

  it('handles nested objects', () => {
    const result = redactSecrets({ outer: { password: 'secret' } });
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('secret');
  });
});

describe('truncate', () => {
  it('returns unchanged string if within limit', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('truncates string exceeding limit', () => {
    const result = truncate('hello world', 5);
    expect(result).toBe('hello...[truncated 6 chars]');
  });

  it('handles exact limit', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('handles empty string', () => {
    expect(truncate('', 10)).toBe('');
  });
});

describe('isPrivateIP', () => {
  it('detects loopback addresses (127.x.x.x)', () => {
    expect(isPrivateIP('127.0.0.1')).toBe(true);
    expect(isPrivateIP('127.255.255.255')).toBe(true);
  });

  it('detects Class A private addresses (10.x.x.x)', () => {
    expect(isPrivateIP('10.0.0.1')).toBe(true);
    expect(isPrivateIP('10.255.255.255')).toBe(true);
  });

  it('detects Class B private addresses (172.16-31.x.x)', () => {
    expect(isPrivateIP('172.16.0.1')).toBe(true);
    expect(isPrivateIP('172.31.255.255')).toBe(true);
    expect(isPrivateIP('172.15.0.1')).toBe(false);
    expect(isPrivateIP('172.32.0.1')).toBe(false);
  });

  it('detects Class C private addresses (192.168.x.x)', () => {
    expect(isPrivateIP('192.168.0.1')).toBe(true);
    expect(isPrivateIP('192.168.255.255')).toBe(true);
  });

  it('detects link-local addresses (169.254.x.x)', () => {
    expect(isPrivateIP('169.254.0.1')).toBe(true);
    expect(isPrivateIP('169.254.169.254')).toBe(true); // AWS metadata
  });

  it('detects current network (0.x.x.x)', () => {
    expect(isPrivateIP('0.0.0.0')).toBe(true);
  });

  it('returns false for public IPs', () => {
    expect(isPrivateIP('8.8.8.8')).toBe(false);
    expect(isPrivateIP('1.1.1.1')).toBe(false);
    expect(isPrivateIP('203.0.113.1')).toBe(false);
  });

  it('detects private IPv6 ranges', () => {
    expect(isPrivateIP('::1')).toBe(true);
    expect(isPrivateIP('fe80::1')).toBe(true);
    expect(isPrivateIP('fc00::1')).toBe(true);
    expect(isPrivateIP('fd00::1')).toBe(true);
    expect(isPrivateIP('2001:4860:4860::8888')).toBe(false);
  });

  it('handles IPv4-mapped IPv6 addresses', () => {
    expect(isPrivateIP('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIP('::ffff:8.8.8.8')).toBe(false);
  });

  it('treats invalid IPs as private (safe default)', () => {
    expect(isPrivateIP('invalid')).toBe(true);
    expect(isPrivateIP('999.999.999.999')).toBe(true);
    expect(isPrivateIP('1.2.3')).toBe(true);
  });
});

describe('ipInCIDR', () => {
  it('matches IP in /8 range', () => {
    expect(ipInCIDR('10.0.0.5', '10.0.0.0/8')).toBe(true);
    expect(ipInCIDR('10.255.255.255', '10.0.0.0/8')).toBe(true);
    expect(ipInCIDR('11.0.0.1', '10.0.0.0/8')).toBe(false);
  });

  it('matches IP in /16 range', () => {
    expect(ipInCIDR('192.168.1.1', '192.168.0.0/16')).toBe(true);
    expect(ipInCIDR('192.169.1.1', '192.168.0.0/16')).toBe(false);
  });

  it('matches IP in /24 range', () => {
    expect(ipInCIDR('192.168.1.100', '192.168.1.0/24')).toBe(true);
    expect(ipInCIDR('192.168.2.100', '192.168.1.0/24')).toBe(false);
  });

  it('matches exact IP with /32', () => {
    expect(ipInCIDR('192.168.1.1', '192.168.1.1/32')).toBe(true);
    expect(ipInCIDR('192.168.1.2', '192.168.1.1/32')).toBe(false);
  });

  it('returns false for invalid inputs', () => {
    expect(ipInCIDR('invalid', '10.0.0.0/8')).toBe(false);
    expect(ipInCIDR('10.0.0.1', 'invalid')).toBe(false);
  });

  it('matches IPv6 CIDR ranges', () => {
    expect(ipInCIDR('fc00::1', 'fc00::/7')).toBe(true);
    expect(ipInCIDR('fe80::1', 'fe80::/10')).toBe(true);
    expect(ipInCIDR('2001:db8::1', '2001:db8::/32')).toBe(true);
    expect(ipInCIDR('2001:db8::1', '2001:db9::/32')).toBe(false);
  });
});
