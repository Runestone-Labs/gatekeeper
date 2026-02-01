import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const TEST_AUDIT_DIR = '/tmp/gatekeeper-test-audit';
const TEST_POLICY_PATH = join(process.cwd(), 'tests/fixtures/test-policy.yaml');

// Mock config before importing logger
vi.mock('../../src/config.js', () => ({
  config: {
    auditDir: '/tmp/gatekeeper-test-audit',
    version: '1.0.0-test',
    policyPath: join(process.cwd(), 'tests/fixtures/test-policy.yaml'),
  },
}));

// Mock policy hash
vi.mock('../../src/policy/loadPolicy.js', () => ({
  getPolicyHash: () => 'sha256:test-policy-hash',
  loadPolicy: () => ({ tools: {} }),
}));

// Import after mocking
const { writeAuditLog, logToolRequest, logToolExecution, logApprovalConsumed } = await import('../../src/audit/logger.js');

describe('audit logger', () => {
  beforeEach(() => {
    if (existsSync(TEST_AUDIT_DIR)) {
      rmSync(TEST_AUDIT_DIR, { recursive: true });
    }
    mkdirSync(TEST_AUDIT_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_AUDIT_DIR)) {
      rmSync(TEST_AUDIT_DIR, { recursive: true });
    }
  });

  describe('writeAuditLog', () => {
    it('creates audit directory if missing', () => {
      rmSync(TEST_AUDIT_DIR, { recursive: true });

      writeAuditLog({
        timestamp: new Date().toISOString(),
        requestId: 'test-123',
        tool: 'shell.exec',
        decision: 'allow',
        actor: { type: 'agent', name: 'test' },
        argsSummary: '{}',
        riskFlags: [],
      });

      expect(existsSync(TEST_AUDIT_DIR)).toBe(true);
    });

    it('writes JSONL format', () => {
      const timestamp = new Date().toISOString();

      writeAuditLog({
        timestamp,
        requestId: 'test-123',
        tool: 'shell.exec',
        decision: 'allow',
        actor: { type: 'agent', name: 'test' },
        argsSummary: '{}',
        riskFlags: [],
      });

      const today = new Date().toISOString().split('T')[0];
      const logFile = join(TEST_AUDIT_DIR, `${today}.jsonl`);

      expect(existsSync(logFile)).toBe(true);

      const content = readFileSync(logFile, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines.length).toBe(1);

      const entry = JSON.parse(lines[0]);
      expect(entry.requestId).toBe('test-123');
      expect(entry.tool).toBe('shell.exec');
      expect(entry.decision).toBe('allow');
    });

    it('includes policy hash and version', () => {
      writeAuditLog({
        timestamp: new Date().toISOString(),
        requestId: 'test-123',
        tool: 'shell.exec',
        decision: 'allow',
        actor: { type: 'agent', name: 'test' },
        argsSummary: '{}',
        riskFlags: [],
      });

      const today = new Date().toISOString().split('T')[0];
      const logFile = join(TEST_AUDIT_DIR, `${today}.jsonl`);
      const content = readFileSync(logFile, 'utf-8');
      const entry = JSON.parse(content.trim());

      expect(entry.policyHash).toBe('sha256:test-policy-hash');
      expect(entry.gatekeeperVersion).toBe('1.0.0-test');
    });

    it('appends multiple entries', () => {
      writeAuditLog({
        timestamp: new Date().toISOString(),
        requestId: 'test-1',
        tool: 'shell.exec',
        decision: 'allow',
        actor: { type: 'agent', name: 'test' },
        argsSummary: '{}',
        riskFlags: [],
      });

      writeAuditLog({
        timestamp: new Date().toISOString(),
        requestId: 'test-2',
        tool: 'files.write',
        decision: 'deny',
        actor: { type: 'agent', name: 'test' },
        argsSummary: '{}',
        riskFlags: ['pattern_match'],
      });

      const today = new Date().toISOString().split('T')[0];
      const logFile = join(TEST_AUDIT_DIR, `${today}.jsonl`);
      const content = readFileSync(logFile, 'utf-8');
      const lines = content.trim().split('\n');

      expect(lines.length).toBe(2);

      const entry1 = JSON.parse(lines[0]);
      const entry2 = JSON.parse(lines[1]);

      expect(entry1.requestId).toBe('test-1');
      expect(entry2.requestId).toBe('test-2');
    });
  });

  describe('logToolRequest', () => {
    it('logs tool request with all fields', () => {
      logToolRequest({
        requestId: 'req-123',
        tool: 'shell.exec',
        decision: 'approve',
        actor: { type: 'agent', name: 'test-agent', runId: 'run-1' },
        argsSummary: '{"command":"ls"}',
        riskFlags: ['needs_approval'],
      });

      const today = new Date().toISOString().split('T')[0];
      const logFile = join(TEST_AUDIT_DIR, `${today}.jsonl`);
      const content = readFileSync(logFile, 'utf-8');
      const entry = JSON.parse(content.trim());

      expect(entry.requestId).toBe('req-123');
      expect(entry.tool).toBe('shell.exec');
      expect(entry.decision).toBe('approve');
      expect(entry.actor.name).toBe('test-agent');
      expect(entry.argsSummary).toContain('command');
      expect(entry.riskFlags).toContain('needs_approval');
      expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('logToolExecution', () => {
    it('logs execution with result', () => {
      logToolExecution({
        requestId: 'req-456',
        tool: 'http.request',
        actor: { type: 'agent', name: 'test-agent' },
        argsSummary: '{"url":"https://example.com"}',
        resultSummary: '{"status":200}',
        riskFlags: [],
      });

      const today = new Date().toISOString().split('T')[0];
      const logFile = join(TEST_AUDIT_DIR, `${today}.jsonl`);
      const content = readFileSync(logFile, 'utf-8');
      const entry = JSON.parse(content.trim());

      expect(entry.decision).toBe('executed');
      expect(entry.resultSummary).toContain('200');
    });
  });

  describe('logApprovalConsumed', () => {
    it('logs approval with action', () => {
      logApprovalConsumed({
        requestId: 'req-789',
        tool: 'shell.exec',
        actor: { type: 'agent', name: 'test-agent' },
        argsSummary: '{"command":"ls"}',
        approvalId: 'approval-123',
        action: 'approved',
        resultSummary: '{"exitCode":0}',
      });

      const today = new Date().toISOString().split('T')[0];
      const logFile = join(TEST_AUDIT_DIR, `${today}.jsonl`);
      const content = readFileSync(logFile, 'utf-8');
      const entry = JSON.parse(content.trim());

      expect(entry.decision).toBe('approval_consumed');
      expect(entry.approvalId).toBe('approval-123');
      expect(entry.riskFlags).toContain('action:approved');
    });

    it('logs denial action', () => {
      logApprovalConsumed({
        requestId: 'req-999',
        tool: 'shell.exec',
        actor: { type: 'agent', name: 'test-agent' },
        argsSummary: '{}',
        approvalId: 'approval-456',
        action: 'denied',
      });

      const today = new Date().toISOString().split('T')[0];
      const logFile = join(TEST_AUDIT_DIR, `${today}.jsonl`);
      const content = readFileSync(logFile, 'utf-8');
      const entry = JSON.parse(content.trim());

      expect(entry.riskFlags).toContain('action:denied');
    });
  });
});
