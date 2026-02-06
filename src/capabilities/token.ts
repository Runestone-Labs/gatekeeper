import crypto from 'node:crypto';
import { config } from '../config.js';

export interface CapabilityTokenPayload {
  tool: string;
  argsHash: string;
  expiresAt: string;
  actorRole?: string;
  actorName?: string;
}

export interface CapabilityValidationResult {
  valid: boolean;
  reasonCode: string;
  humanExplanation: string;
  remediation?: string;
  payload?: CapabilityTokenPayload;
}

export function createCapabilityToken(payload: CapabilityTokenPayload): string {
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = sign(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

export function validateCapabilityToken(params: {
  token: string;
  toolName: string;
  argsHash: string;
  actorRole?: string;
  actorName?: string;
}): CapabilityValidationResult {
  const parsed = parseToken(params.token);
  if (!parsed) {
    return {
      valid: false,
      reasonCode: 'CAPABILITY_TOKEN_INVALID',
      humanExplanation: 'Capability token is malformed or cannot be verified.',
      remediation: 'Reissue the capability token and retry.',
    };
  }

  const { payload } = parsed;

  if (payload.tool !== params.toolName) {
    return {
      valid: false,
      reasonCode: 'CAPABILITY_TOOL_MISMATCH',
      humanExplanation: 'Capability token does not apply to this tool.',
      remediation: 'Use a capability token scoped to this tool.',
    };
  }

  if (payload.argsHash !== params.argsHash) {
    return {
      valid: false,
      reasonCode: 'CAPABILITY_ARGS_MISMATCH',
      humanExplanation: 'Capability token arguments do not match this request.',
      remediation: 'Generate a token for these exact arguments.',
    };
  }

  if (payload.actorRole && payload.actorRole !== params.actorRole) {
    return {
      valid: false,
      reasonCode: 'CAPABILITY_ROLE_MISMATCH',
      humanExplanation: 'Capability token is scoped to a different role.',
      remediation: 'Use a token issued for this actor role.',
    };
  }

  if (payload.actorName && payload.actorName !== params.actorName) {
    return {
      valid: false,
      reasonCode: 'CAPABILITY_ACTOR_MISMATCH',
      humanExplanation: 'Capability token is scoped to a different actor.',
      remediation: 'Use a token issued for this actor.',
    };
  }

  const expiresAt = new Date(payload.expiresAt);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() < Date.now()) {
    return {
      valid: false,
      reasonCode: 'CAPABILITY_EXPIRED',
      humanExplanation: 'Capability token has expired.',
      remediation: 'Issue a new capability token.',
    };
  }

  return {
    valid: true,
    reasonCode: 'CAPABILITY_VALID',
    humanExplanation: 'Capability token is valid.',
    payload,
  };
}

function parseToken(token: string): { payload: CapabilityTokenPayload } | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [encodedPayload, signature] = parts;
  const expected = sign(encodedPayload);
  if (!safeEqual(signature, expected)) return null;

  try {
    const json = base64UrlDecode(encodedPayload);
    const payload = JSON.parse(json) as CapabilityTokenPayload;
    if (!payload.tool || !payload.argsHash || !payload.expiresAt) {
      return null;
    }
    return { payload };
  } catch {
    return null;
  }
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', config.secret).update(payload).digest('hex');
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + '='.repeat(padLength), 'base64').toString('utf-8');
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
