import { describe, it, expect } from 'vitest';
import {
  decisionToToolResult,
  errorToToolResult,
  isValidToolName,
  assertValidToolName,
  sanitize,
} from './translate.js';

describe('decisionToToolResult — fail-closed decision mapping', () => {
  it('allow → success with the payload', () => {
    const r = decisionToToolResult({ decision: 'allow', requestId: '1', result: { stdout: 'hi' } });
    expect(r.isError).toBe(false);
    expect(r.content[0]!.text).toContain('hi');
  });

  it('allow with no payload is still a success ({ok:true})', () => {
    const r = decisionToToolResult({ decision: 'allow', requestId: '1' });
    expect(r.isError).toBe(false);
    expect(r.content[0]!.text).toContain('ok');
  });

  it('deny → isError, surfaces reason, and NEVER leaks a result field', () => {
    // Adversarial: a malformed/hostile response carries decision:deny but also a
    // result payload. We must report the denial, not the payload.
    const r = decisionToToolResult({
      decision: 'deny',
      requestId: '1',
      reasonCode: 'EGRESS_BLOCKED',
      humanExplanation: 'host not allowed',
      result: { stdout: 'SHOULD NOT APPEAR' },
    });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('EGRESS_BLOCKED');
    expect(r.content[0]!.text).not.toContain('SHOULD NOT APPEAR');
  });

  it('approve → isError and explicitly says it did NOT execute', () => {
    const r = decisionToToolResult({
      decision: 'approve',
      requestId: '1',
      approvalId: 'appr_1',
      humanExplanation: 'needs a human',
    });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('did NOT execute');
    expect(r.content[0]!.text).toContain('appr_1');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty object', {}],
    ['string', 'allow'],
    ['number', 1],
    ['unknown decision', { decision: 'yolo', result: { stdout: 'x' } }],
    ['missing decision but has result', { result: { stdout: 'pwned' }, success: true }],
  ])('fails closed on %s', (_label, input) => {
    const r = decisionToToolResult(input);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text.toLowerCase()).toContain('denied');
  });

  it('a success-looking object without decision:allow does not leak its result', () => {
    const r = decisionToToolResult({ success: true, result: { stdout: 'pwned' } });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).not.toContain('pwned');
  });
});

describe('decision paths sanitize gatekeeper-supplied text (red-team: deny/approve leakage)', () => {
  it('redacts a host + bearer token echoed in a DENY explanation', () => {
    const r = decisionToToolResult(
      {
        decision: 'deny',
        reasonCode: 'UPSTREAM',
        humanExplanation:
          'upstream http://10.0.0.5:5432 said Authorization: Bearer sk-live-abc123def456 failed',
      },
      'http://gk.internal:3847'
    );
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).not.toContain('sk-live-abc123def456');
    expect(r.content[0]!.text).toContain('<redacted>');
  });

  it('redacts a JSON-quoted token and a connection-string password in a deny', () => {
    const r = decisionToToolResult({
      decision: 'deny',
      humanExplanation:
        'config {"token":"abcdef1234567890abcdef"} dsn postgres://admin:s3cretpw@db.internal:5432/x',
    });
    expect(r.content[0]!.text).not.toContain('abcdef1234567890abcdef');
    expect(r.content[0]!.text).not.toContain('s3cretpw');
  });

  it('redacts the configured gatekeeper host (case-insensitive) from a deny', () => {
    const r = decisionToToolResult(
      { decision: 'deny', humanExplanation: 'could not reach GK.Internal:3847/tool/x' },
      'http://gk.internal:3847'
    );
    expect(r.content[0]!.text.toLowerCase()).not.toContain('gk.internal');
  });

  it('preserves a UUID approvalId verbatim (must survive sanitization)', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    const r = decisionToToolResult(
      { decision: 'approve', approvalId: id, humanExplanation: 'ok' },
      'http://gk:3847'
    );
    expect(r.content[0]!.text).toContain(id);
  });
});

describe('allow branch is self-contained fail-closed (red-team: unguarded JSON.stringify)', () => {
  it.each([
    ['BigInt', { decision: 'allow', result: { n: 10n } }],
    [
      'circular',
      (() => {
        const o: Record<string, unknown> = { decision: 'allow' };
        const c: Record<string, unknown> = {};
        c.self = c;
        o.result = c;
        return o;
      })(),
    ],
    [
      'throwing toJSON',
      {
        decision: 'allow',
        result: {
          toJSON() {
            throw new Error('boom');
          },
        },
      },
    ],
  ])('returns a fail-closed error (not a throw) for a %s allow payload', (_label, input) => {
    const r = decisionToToolResult(input as unknown);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text.toLowerCase()).toContain('denied');
  });

  it('does NOT sanitize a legitimate allow output (data the caller asked for)', () => {
    // A real http_request result may legitimately contain token-like strings.
    const r = decisionToToolResult({
      decision: 'allow',
      result: { body: 'the page mentions sk-live-keepme' },
    });
    expect(r.isError).toBe(false);
    expect(r.content[0]!.text).toContain('sk-live-keepme');
  });
});

describe('sanitize — credential shapes', () => {
  it.each([
    ['JWT', 'tok eyJhbGciOiJIUzI1Ni1.eyJzdWIiOiIxMjM0NQ.SflKxwRJSMeKKF2QT4', 'eyJhbGc'],
    ['AWS key', 'key AKIAIOSFODNN7EXAMPLE here', 'AKIAIOSFODNN7EXAMPLE'],
    [
      'github token',
      'gho_16C7e42F292c6912E7710c838347Ae178B4a',
      'gho_16C7e42F292c6912E7710c838347Ae178B4a',
    ],
    [
      'hex blob',
      'hash 0123456789abcdef0123456789abcdef0123 end',
      '0123456789abcdef0123456789abcdef0123',
    ],
  ])('redacts %s', (_label, input, secret) => {
    expect(sanitize(input)).not.toContain(secret);
  });

  it('leaves short/benign identifiers and UUIDs alone', () => {
    expect(sanitize('order 12345 for user-42 id 550e8400-e29b-41d4-a716-446655440000')).toContain(
      '550e8400-e29b-41d4-a716-446655440000'
    );
  });
});

describe('tool-name validation — anti path-traversal', () => {
  it.each(['shell.exec', 'http.request', 'memory.query', 'a', 'a.b.c'])('accepts %s', (n) => {
    expect(isValidToolName(n)).toBe(true);
  });

  it.each([
    '../admin',
    'shell/exec',
    '/health',
    'shell.exec/../admin',
    'shell exec',
    'Shell.Exec',
    '',
    '.foo',
    'foo.',
    'foo..bar',
    'foo;rm -rf',
    '%2e%2e',
    'http://evil',
    'a'.repeat(100),
  ])('rejects %s', (n) => {
    expect(isValidToolName(n)).toBe(false);
    expect(() => assertValidToolName(n)).toThrow();
  });

  it('rejects non-strings', () => {
    expect(isValidToolName(123 as unknown)).toBe(false);
    expect(isValidToolName(null as unknown)).toBe(false);
    expect(isValidToolName({} as unknown)).toBe(false);
  });
});

describe('errorToToolResult — fail-closed + no leakage', () => {
  it('is always an error result', () => {
    expect(errorToToolResult(new Error('boom')).isError).toBe(true);
  });

  it('redacts the gatekeeper base URL', () => {
    const r = errorToToolResult(
      new Error('fetch http://secret-host:3847/tool/x failed'),
      'http://secret-host:3847'
    );
    expect(r.content[0]!.text).not.toContain('secret-host');
    expect(r.content[0]!.text).toContain('<gatekeeper>');
  });

  it('redacts token/bearer-looking substrings', () => {
    const r = errorToToolResult(new Error('Authorization: Bearer sk-supersecret-123'));
    expect(r.content[0]!.text.toLowerCase()).not.toContain('sk-supersecret-123');
    expect(r.content[0]!.text).toContain('<redacted>');
  });
});
