import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const TEST_AUDIT_DIR = '/tmp/gatekeeper-test-audit';

// Mock config before importing logger
vi.mock('../../src/config.js', () => ({
  config: {
    auditDir: '/tmp/gatekeeper-test-audit',
    version: '1.0.0-test',
    policyPath: join(process.cwd(), 'tests/fixtures/test-policy.yaml'),
    approvalProvider: 'local',
    auditSink: 'jsonl',
    policySource: 'yaml',
  },
}));

// Mock providers
vi.mock('../../src/providers/index.js', () => ({
  getPolicySource: () => ({
    name: 'yaml',
    getHash: () => 'sha256:test-policy-hash',
    load: async () => ({ tools: {} }),
  }),
  getAuditSink: () => ({
    name: 'jsonl',
    write: async (entry: Record<string, unknown>) => {
      // Actually write to disk for tests
      const { appendFileSync, mkdirSync, existsSync } = await import('node:fs');
      const { join } = await import('node:path');

      const auditDir = '/tmp/gatekeeper-test-audit';
      if (!existsSync(auditDir)) {
        mkdirSync(auditDir, { recursive: true });
      }

      const today = new Date().toISOString().split('T')[0];
      const logFile = join(auditDir, `${today}.jsonl`);
      const line = JSON.stringify(entry) + '\n';
      appendFileSync(logFile, line, 'utf-8');
    },
  }),
  getApprovalProvider: () => ({
    name: 'local',
    requestApproval: async () => true,
  }),
}));

// Import after mocking
const { writeAuditLog, logToolRequest, logToolExecution, logApprovalConsumed, countResultRows } =
  await import('../../src/audit/logger.js');

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

  // Helper to wait for async writes
  const waitForWrite = () => new Promise((resolve) => setTimeout(resolve, 50));

  describe('writeAuditLog', () => {
    it('creates audit directory if missing', async () => {
      rmSync(TEST_AUDIT_DIR, { recursive: true });

      writeAuditLog({
        timestamp: new Date().toISOString(),
        requestId: 'test-123',
        tool: 'shell.exec',
        decision: 'allow',
        actor: { type: 'agent', name: 'test', role: 'openclaw' },
        argsSummary: '{}',
        riskFlags: [],
      });

      await waitForWrite();
      expect(existsSync(TEST_AUDIT_DIR)).toBe(true);
    });

    it('writes JSONL format', async () => {
      const timestamp = new Date().toISOString();

      writeAuditLog({
        timestamp,
        requestId: 'test-123',
        tool: 'shell.exec',
        decision: 'allow',
        actor: { type: 'agent', name: 'test', role: 'openclaw' },
        argsSummary: '{}',
        riskFlags: [],
      });

      await waitForWrite();

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

    it('includes policy hash and version', async () => {
      writeAuditLog({
        timestamp: new Date().toISOString(),
        requestId: 'test-123',
        tool: 'shell.exec',
        decision: 'allow',
        actor: { type: 'agent', name: 'test', role: 'openclaw' },
        argsSummary: '{}',
        riskFlags: [],
      });

      await waitForWrite();

      const today = new Date().toISOString().split('T')[0];
      const logFile = join(TEST_AUDIT_DIR, `${today}.jsonl`);
      const content = readFileSync(logFile, 'utf-8');
      const entry = JSON.parse(content.trim());

      expect(entry.policyHash).toBe('sha256:test-policy-hash');
      expect(entry.gatekeeperVersion).toBe('1.0.0-test');
    });

    it('appends multiple entries', async () => {
      writeAuditLog({
        timestamp: new Date().toISOString(),
        requestId: 'test-1',
        tool: 'shell.exec',
        decision: 'allow',
        actor: { type: 'agent', name: 'test', role: 'openclaw' },
        argsSummary: '{}',
        riskFlags: [],
      });

      await waitForWrite();

      writeAuditLog({
        timestamp: new Date().toISOString(),
        requestId: 'test-2',
        tool: 'files.write',
        decision: 'deny',
        actor: { type: 'agent', name: 'test', role: 'openclaw' },
        argsSummary: '{}',
        riskFlags: ['pattern_match'],
      });

      await waitForWrite();

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
    it('logs tool request with all fields', async () => {
      logToolRequest({
        requestId: 'req-123',
        tool: 'shell.exec',
        decision: 'approve',
        actor: { type: 'agent', name: 'test-agent', role: 'openclaw', runId: 'run-1' },
        argsSummary: '{"command":"ls"}',
        argsHash: 'sha256:args-hash',
        riskFlags: ['needs_approval'],
        reasonCode: 'POLICY_APPROVAL_REQUIRED',
        humanExplanation: 'Approval required.',
      });

      await waitForWrite();

      const today = new Date().toISOString().split('T')[0];
      const logFile = join(TEST_AUDIT_DIR, `${today}.jsonl`);
      const content = readFileSync(logFile, 'utf-8');
      const entry = JSON.parse(content.trim());

      expect(entry.requestId).toBe('req-123');
      expect(entry.tool).toBe('shell.exec');
      expect(entry.decision).toBe('approve');
      expect(entry.actor.name).toBe('test-agent');
      expect(entry.argsSummary).toContain('command');
      expect(entry.argsHash).toBe('sha256:args-hash');
      expect(entry.riskFlags).toContain('needs_approval');
      expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('countResultRows', () => {
    it('counts a data array (memory.query list shapes)', () => {
      expect(
        countResultRows({ success: true, output: { type: 'entities', data: [{}, {}, {}] } })
      ).toBe(3);
      expect(countResultRows({ success: true, output: { type: 'episodes', data: [] } })).toBe(0);
    });

    it('counts a single-row data field (entity-by-id)', () => {
      expect(
        countResultRows({ success: true, output: { type: 'entity', data: { id: 'x' } } })
      ).toBe(1);
      expect(countResultRows({ success: true, output: { type: 'entity', data: null } })).toBe(0);
    });

    it('counts a top-level array output', () => {
      expect(countResultRows({ success: true, output: [1, 2] })).toBe(2);
    });

    it('returns null where rows do not apply', () => {
      expect(
        countResultRows({ success: true, output: { episode: {}, linkedEntities: 1 } })
      ).toBeNull();
      expect(countResultRows({ success: true, output: 'ok' })).toBeNull();
      expect(countResultRows({ success: true })).toBeNull();
      expect(countResultRows({ success: false, error: 'boom' })).toBeNull();
    });
  });

  describe('logToolExecution', () => {
    it('records durationMs and resultCount on the executed audit row', async () => {
      logToolExecution({
        requestId: 'req-enriched',
        tool: 'memory.query',
        actor: { type: 'agent', name: 'test-agent', role: 'openclaw' },
        argsSummary: '{"entityName":"Gatekeeper"}',
        resultSummary: '{"type":"entities"}',
        executionReceipt: {
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: 12,
          resultCount: countResultRows({
            success: true,
            output: { type: 'entities', data: [{}, {}] },
          }),
        },
        riskFlags: [],
      });

      await waitForWrite();

      const today = new Date().toISOString().split('T')[0];
      const logFile = join(TEST_AUDIT_DIR, `${today}.jsonl`);
      const entry = JSON.parse(readFileSync(logFile, 'utf-8').trim());

      expect(entry.decision).toBe('executed');
      expect(entry.executionReceipt.durationMs).toBe(12);
      expect(entry.executionReceipt.resultCount).toBe(2);
    });

    it('logs execution with result', async () => {
      logToolExecution({
        requestId: 'req-456',
        tool: 'http.request',
        actor: { type: 'agent', name: 'test-agent', role: 'openclaw' },
        argsSummary: '{"url":"https://example.com"}',
        argsHash: 'sha256:exec-hash',
        resultSummary: '{"status":200}',
        executionReceipt: {
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: 5,
        },
        riskFlags: [],
      });

      await waitForWrite();

      const today = new Date().toISOString().split('T')[0];
      const logFile = join(TEST_AUDIT_DIR, `${today}.jsonl`);
      const content = readFileSync(logFile, 'utf-8');
      const entry = JSON.parse(content.trim());

      expect(entry.decision).toBe('executed');
      expect(entry.resultSummary).toContain('200');
      expect(entry.argsHash).toBe('sha256:exec-hash');
      expect(entry.executionReceipt).toBeDefined();
    });
  });

  describe('logApprovalConsumed', () => {
    it('logs approval with action', async () => {
      logApprovalConsumed({
        requestId: 'req-789',
        tool: 'shell.exec',
        actor: { type: 'agent', name: 'test-agent', role: 'openclaw' },
        argsSummary: '{"command":"ls"}',
        argsHash: 'sha256:approval-hash',
        approvalId: 'approval-123',
        action: 'approved',
        resultSummary: '{"exitCode":0}',
        reasonCode: 'APPROVAL_APPROVED',
        humanExplanation: 'Approved.',
      });

      await waitForWrite();

      const today = new Date().toISOString().split('T')[0];
      const logFile = join(TEST_AUDIT_DIR, `${today}.jsonl`);
      const content = readFileSync(logFile, 'utf-8');
      const entry = JSON.parse(content.trim());

      expect(entry.decision).toBe('approval_consumed');
      expect(entry.approvalId).toBe('approval-123');
      expect(entry.argsHash).toBe('sha256:approval-hash');
      expect(entry.reasonCode).toBe('APPROVAL_APPROVED');
      expect(entry.riskFlags).toContain('action:approved');
    });

    it('logs denial action', async () => {
      logApprovalConsumed({
        requestId: 'req-999',
        tool: 'shell.exec',
        actor: { type: 'agent', name: 'test-agent', role: 'openclaw' },
        argsSummary: '{}',
        approvalId: 'approval-456',
        action: 'denied',
      });

      await waitForWrite();

      const today = new Date().toISOString().split('T')[0];
      const logFile = join(TEST_AUDIT_DIR, `${today}.jsonl`);
      const content = readFileSync(logFile, 'utf-8');
      const entry = JSON.parse(content.trim());

      expect(entry.riskFlags).toContain('action:denied');
    });
  });
});
