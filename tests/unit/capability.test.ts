import { describe, it, expect } from 'vitest';

process.env.GATEKEEPER_SECRET = 'test-secret-key-at-least-32-characters-long';

const { createCapabilityToken, validateCapabilityToken } = await import(
  '../../src/capabilities/token.js'
);

describe('capability tokens', () => {
  it('validates a signed token', () => {
    const payload = {
      tool: 'shell.exec',
      argsHash: 'sha256:test-args',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      actorRole: 'openclaw',
    };

    const token = createCapabilityToken(payload);
    const result = validateCapabilityToken({
      token,
      toolName: 'shell.exec',
      argsHash: 'sha256:test-args',
      actorRole: 'openclaw',
      actorName: 'agent',
    });

    expect(result.valid).toBe(true);
    expect(result.reasonCode).toBe('CAPABILITY_VALID');
  });

  it('rejects mismatched args hash', () => {
    const payload = {
      tool: 'shell.exec',
      argsHash: 'sha256:one',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };

    const token = createCapabilityToken(payload);
    const result = validateCapabilityToken({
      token,
      toolName: 'shell.exec',
      argsHash: 'sha256:two',
    });

    expect(result.valid).toBe(false);
    expect(result.reasonCode).toBe('CAPABILITY_ARGS_MISMATCH');
  });

  it('rejects expired token', () => {
    const payload = {
      tool: 'shell.exec',
      argsHash: 'sha256:test-args',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    };

    const token = createCapabilityToken(payload);
    const result = validateCapabilityToken({
      token,
      toolName: 'shell.exec',
      argsHash: 'sha256:test-args',
    });

    expect(result.valid).toBe(false);
    expect(result.reasonCode).toBe('CAPABILITY_EXPIRED');
  });
});
