import { describe, it, expect } from 'vitest';
import {
  ToolRequestSchema,
  ContextRefSchema,
  OriginSchema,
} from '../../src/tools/schemas.js';
import { evaluateTool, EvaluationEnvelope } from '../../src/policy/evaluate.js';
import { Policy, PrincipalPolicy } from '../../src/types.js';
import {
  checkAlertBudget,
  getEffectiveRole,
  mergePrincipalPolicies,
  validatePrincipalPolicy,
  resetAlertTrackers,
} from '../../src/policy/principals.js';

describe('v1 Envelope Schema', () => {
  describe('ToolRequestSchema with v1 fields', () => {
    it('accepts request with v1 envelope fields', () => {
      const result = ToolRequestSchema.safeParse({
        requestId: '550e8400-e29b-41d4-a716-446655440000',
        actor: { type: 'agent', name: 'test-agent', role: 'navigator' },
        args: { command: 'ls' },
        origin: 'user_direct',
        taint: ['external'],
        contextRefs: [{ type: 'url', id: 'https://example.com' }],
        dryRun: true,
      });
      expect(result.success).toBe(true);
    });

    it('accepts request without v1 fields (backwards compatible)', () => {
      const result = ToolRequestSchema.safeParse({
        requestId: '550e8400-e29b-41d4-a716-446655440000',
        actor: { type: 'agent', name: 'test-agent' },
        args: { command: 'ls' },
      });
      expect(result.success).toBe(true);
    });

    it('accepts all origin types', () => {
      const origins = ['user_direct', 'model_inferred', 'external_content', 'background_job'];
      for (const origin of origins) {
        const result = OriginSchema.safeParse(origin);
        expect(result.success).toBe(true);
      }
    });

    it('rejects invalid origin', () => {
      const result = ToolRequestSchema.safeParse({
        requestId: '550e8400-e29b-41d4-a716-446655440000',
        actor: { type: 'agent', name: 'test-agent' },
        args: {},
        origin: 'invalid_origin',
      });
      expect(result.success).toBe(false);
    });

    it('accepts all context ref types', () => {
      const types = ['message', 'url', 'document', 'memory_entity'];
      for (const type of types) {
        const result = ContextRefSchema.safeParse({ type, id: 'test-id' });
        expect(result.success).toBe(true);
      }
    });

    it('rejects invalid context ref type', () => {
      const result = ContextRefSchema.safeParse({ type: 'invalid', id: 'test-id' });
      expect(result.success).toBe(false);
    });

    it('accepts context ref with taint', () => {
      const result = ContextRefSchema.safeParse({
        type: 'url',
        id: 'https://example.com',
        taint: ['external', 'untrusted'],
      });
      expect(result.success).toBe(true);
    });
  });
});

describe('Taint-aware Policy Evaluation', () => {
  const basePolicy: Policy = {
    tools: {
      'shell.exec': { decision: 'allow' },
      'files.write': { decision: 'allow' },
      'http.request': { decision: 'allow' },
    },
  };

  it('allows request without taint', () => {
    const envelope: EvaluationEnvelope = {
      requestId: 'test-123',
      actor: { type: 'agent', name: 'test' },
      args: { command: 'ls' },
    };
    const result = evaluateTool('shell.exec', { command: 'ls' }, basePolicy, envelope);
    expect(result.decision).toBe('allow');
  });

  it('requires approval for shell.exec with external taint', () => {
    const envelope: EvaluationEnvelope = {
      requestId: 'test-123',
      actor: { type: 'agent', name: 'test' },
      args: { command: 'ls' },
      taint: ['external'],
    };
    const result = evaluateTool('shell.exec', { command: 'ls' }, basePolicy, envelope);
    expect(result.decision).toBe('approve');
    expect(result.riskFlags).toContain('tainted_exec');
    expect(result.riskFlags).toContain('external_content');
  });

  it('requires approval for shell.exec with untrusted taint', () => {
    const envelope: EvaluationEnvelope = {
      requestId: 'test-123',
      actor: { type: 'agent', name: 'test' },
      args: { command: 'ls' },
      taint: ['untrusted'],
    };
    const result = evaluateTool('shell.exec', { command: 'ls' }, basePolicy, envelope);
    expect(result.decision).toBe('approve');
  });

  it('denies files.write to system path with external taint', () => {
    const envelope: EvaluationEnvelope = {
      requestId: 'test-123',
      actor: { type: 'agent', name: 'test' },
      args: { path: '/etc/passwd', content: 'hack' },
      taint: ['external'],
    };
    const result = evaluateTool('files.write', { path: '/etc/passwd', content: 'hack' }, basePolicy, envelope);
    expect(result.decision).toBe('deny');
    expect(result.riskFlags).toContain('tainted_write');
    expect(result.riskFlags).toContain('system_path');
  });

  it('requires approval for files.write to non-system path with external taint', () => {
    const envelope: EvaluationEnvelope = {
      requestId: 'test-123',
      actor: { type: 'agent', name: 'test' },
      args: { path: '/tmp/test.txt', content: 'hello' },
      taint: ['external'],
    };
    const result = evaluateTool('files.write', { path: '/tmp/test.txt', content: 'hello' }, basePolicy, envelope);
    expect(result.decision).toBe('approve');
    expect(result.riskFlags).toContain('tainted_write');
  });

  it('denies http.request to internal host with external taint', () => {
    const envelope: EvaluationEnvelope = {
      requestId: 'test-123',
      actor: { type: 'agent', name: 'test' },
      args: { url: 'http://localhost:8080/admin', method: 'GET' },
      taint: ['external'],
    };
    const result = evaluateTool('http.request', { url: 'http://localhost:8080/admin', method: 'GET' }, basePolicy, envelope);
    expect(result.decision).toBe('deny');
    expect(result.riskFlags).toContain('internal_host');
  });

  it('denies http.request to AWS metadata endpoint with external taint', () => {
    const envelope: EvaluationEnvelope = {
      requestId: 'test-123',
      actor: { type: 'agent', name: 'test' },
      args: { url: 'http://169.254.169.254/latest/meta-data/', method: 'GET' },
      taint: ['external'],
    };
    const result = evaluateTool('http.request', { url: 'http://169.254.169.254/latest/meta-data/', method: 'GET' }, basePolicy, envelope);
    expect(result.decision).toBe('deny');
    expect(result.riskFlags).toContain('internal_host');
  });

  it('allows http.request to external host with external taint', () => {
    const envelope: EvaluationEnvelope = {
      requestId: 'test-123',
      actor: { type: 'agent', name: 'test' },
      args: { url: 'https://api.example.com/data', method: 'GET' },
      taint: ['external'],
    };
    const result = evaluateTool('http.request', { url: 'https://api.example.com/data', method: 'GET' }, basePolicy, envelope);
    expect(result.decision).toBe('allow');
  });
});

describe('Principal/Role Policy Evaluation', () => {
  const policyWithPrincipals: Policy = {
    tools: {
      'shell.exec': { decision: 'allow' },
      'files.write': { decision: 'allow' },
      'http.request': { decision: 'allow' },
      'memory.query': { decision: 'allow' },
    },
    principals: {
      navigator: {
        allowedTools: ['http.request', 'memory.query'],
        requireApproval: ['shell.exec', 'files.write'],
      },
      sentinel: {
        allowedTools: ['http.request', 'memory.query'],
        denyPatterns: ['rm', 'delete', 'drop'],
      },
      archivist: {
        allowedTools: ['memory.query'],
        denyPatterns: [],
      },
    },
  };

  it('denies tool not in allowedTools for principal', () => {
    const envelope: EvaluationEnvelope = {
      requestId: 'test-123',
      actor: { type: 'agent', name: 'navigator-agent', role: 'navigator' },
      args: { command: 'ls' },
    };
    // shell.exec is not in allowedTools, but is in requireApproval
    // This should trigger the requireApproval check
    const result = evaluateTool('shell.exec', { command: 'ls' }, policyWithPrincipals, envelope);
    expect(result.decision).toBe('approve');
    expect(result.riskFlags).toContain('principal_approval');
  });

  it('requires approval for tools in requireApproval list', () => {
    const envelope: EvaluationEnvelope = {
      requestId: 'test-123',
      actor: { type: 'agent', name: 'navigator-agent', role: 'navigator' },
      args: { path: '/tmp/test.txt', content: 'hello' },
    };
    const result = evaluateTool('files.write', { path: '/tmp/test.txt', content: 'hello' }, policyWithPrincipals, envelope);
    expect(result.decision).toBe('approve');
    expect(result.riskFlags).toContain('role:navigator');
  });

  it('allows tools in allowedTools for principal', () => {
    const envelope: EvaluationEnvelope = {
      requestId: 'test-123',
      actor: { type: 'agent', name: 'navigator-agent', role: 'navigator' },
      args: { url: 'https://example.com', method: 'GET' },
    };
    const result = evaluateTool('http.request', { url: 'https://example.com', method: 'GET' }, policyWithPrincipals, envelope);
    expect(result.decision).toBe('allow');
  });

  it('denies based on principal deny pattern', () => {
    const envelope: EvaluationEnvelope = {
      requestId: 'test-123',
      actor: { type: 'agent', name: 'sentinel-agent', role: 'sentinel' },
      args: { command: 'rm -rf /tmp/test' },
    };
    const result = evaluateTool('shell.exec', { command: 'rm -rf /tmp/test' }, policyWithPrincipals, envelope);
    expect(result.decision).toBe('deny');
    expect(result.riskFlags).toContain('principal_pattern_match');
  });

  it('denies tool not in allowedTools (no requireApproval)', () => {
    const envelope: EvaluationEnvelope = {
      requestId: 'test-123',
      actor: { type: 'agent', name: 'archivist-agent', role: 'archivist' },
      args: { command: 'ls' },
    };
    const result = evaluateTool('shell.exec', { command: 'ls' }, policyWithPrincipals, envelope);
    expect(result.decision).toBe('deny');
    expect(result.riskFlags).toContain('principal_denied');
  });

  it('uses default behavior for unknown role', () => {
    const envelope: EvaluationEnvelope = {
      requestId: 'test-123',
      actor: { type: 'agent', name: 'unknown-agent', role: 'unknown' },
      args: { command: 'ls' },
    };
    const result = evaluateTool('shell.exec', { command: 'ls' }, policyWithPrincipals, envelope);
    // Unknown role uses default tool-level policy (allow)
    expect(result.decision).toBe('allow');
  });
});

describe('Principal Utilities', () => {
  beforeEach(() => {
    resetAlertTrackers();
  });

  describe('checkAlertBudget', () => {
    it('allows alert when no budget defined', () => {
      const result = checkAlertBudget('test', 'low', undefined);
      expect(result.allowed).toBe(true);
    });

    it('blocks alert below severity threshold', () => {
      const budget = { maxPerHour: 10, severityThreshold: 'high' as const };
      const result = checkAlertBudget('test', 'low', budget);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('severity');
    });

    it('allows alert at severity threshold', () => {
      const budget = { maxPerHour: 10, severityThreshold: 'medium' as const };
      const result = checkAlertBudget('test', 'high', budget);
      expect(result.allowed).toBe(true);
    });

    it('blocks alert when budget exhausted', () => {
      const budget = { maxPerHour: 2, severityThreshold: 'low' as const };

      expect(checkAlertBudget('test', 'high', budget).allowed).toBe(true);
      expect(checkAlertBudget('test', 'high', budget).allowed).toBe(true);
      expect(checkAlertBudget('test', 'high', budget).allowed).toBe(false);
    });
  });

  describe('getEffectiveRole', () => {
    it('returns explicit role when set', () => {
      expect(getEffectiveRole({ name: 'agent', role: 'navigator' })).toBe('navigator');
    });

    it('falls back to name when no role', () => {
      expect(getEffectiveRole({ name: 'agent' })).toBe('agent');
    });
  });

  describe('mergePrincipalPolicies', () => {
    it('merges policies correctly', () => {
      const base: PrincipalPolicy = {
        allowedTools: ['tool1'],
        denyPatterns: ['pattern1'],
        requireApproval: ['tool2'],
      };
      const override: Partial<PrincipalPolicy> = {
        allowedTools: ['tool3'],
        denyPatterns: ['pattern2'],
      };
      const result = mergePrincipalPolicies(base, override);
      expect(result.allowedTools).toEqual(['tool3']);
      expect(result.denyPatterns).toEqual(['pattern1', 'pattern2']);
      expect(result.requireApproval).toEqual(['tool2']);
    });
  });

  describe('validatePrincipalPolicy', () => {
    it('accepts valid policy', () => {
      const policy = {
        allowedTools: ['shell.exec'],
        denyPatterns: ['rm.*-rf'],
        requireApproval: ['files.write'],
        alertBudget: { maxPerHour: 5, severityThreshold: 'high' },
      };
      const result = validatePrincipalPolicy('test', policy);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('rejects non-object policy', () => {
      const result = validatePrincipalPolicy('test', 'not-an-object');
      expect(result.valid).toBe(false);
    });

    it('rejects invalid regex pattern', () => {
      const policy = { denyPatterns: ['[invalid'] };
      const result = validatePrincipalPolicy('test', policy);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('invalid regex');
    });

    it('rejects invalid alertBudget', () => {
      const policy = { alertBudget: { maxPerHour: -1, severityThreshold: 'invalid' } };
      const result = validatePrincipalPolicy('test', policy);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });
});

describe('Backwards Compatibility', () => {
  const policy: Policy = {
    tools: {
      'shell.exec': { decision: 'allow' },
    },
  };

  it('evaluates correctly without envelope', () => {
    const result = evaluateTool('shell.exec', { command: 'ls' }, policy);
    expect(result.decision).toBe('allow');
  });

  it('evaluates correctly with empty envelope', () => {
    const envelope: EvaluationEnvelope = {
      requestId: 'test-123',
      actor: { type: 'agent', name: 'test' },
      args: { command: 'ls' },
    };
    const result = evaluateTool('shell.exec', { command: 'ls' }, policy, envelope);
    expect(result.decision).toBe('allow');
  });

  it('evaluates correctly with envelope but no taint/role', () => {
    const envelope: EvaluationEnvelope = {
      requestId: 'test-123',
      actor: { type: 'agent', name: 'test' },
      args: { command: 'ls' },
      origin: 'user_direct',
    };
    const result = evaluateTool('shell.exec', { command: 'ls' }, policy, envelope);
    expect(result.decision).toBe('allow');
  });
});
