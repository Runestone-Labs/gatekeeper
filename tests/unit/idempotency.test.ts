import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DIR = '/tmp/gatekeeper-idempotency-test';

vi.mock('../../src/config.js', () => ({
  config: {
    idempotencyDir: TEST_DIR,
  },
}));

const { createPendingRecord, getIdempotencyRecord, completeIdempotencyRecord } =
  await import('../../src/idempotency/store.js');

describe('idempotency store', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  it('creates and persists pending records', () => {
    const record = createPendingRecord({
      key: 'test-key',
      requestId: 'req-1',
      toolName: 'shell.exec',
      argsHash: 'sha256:abc',
    });

    expect(record.status).toBe('pending');
    const stored = getIdempotencyRecord('test-key');
    expect(stored).not.toBeNull();
    expect(stored?.toolName).toBe('shell.exec');

    const files = readdirSync(TEST_DIR);
    expect(files.length).toBeGreaterThan(0);
    if (process.platform !== 'win32') {
      expect(statSync(TEST_DIR).mode & 0o777).toBe(0o700);
      expect(statSync(join(TEST_DIR, files[0])).mode & 0o777).toBe(0o600);
    }
  });

  it('completes records with response', () => {
    createPendingRecord({
      key: 'complete-key',
      requestId: 'req-2',
      toolName: 'http.request',
      argsHash: 'sha256:def',
    });

    const updated = completeIdempotencyRecord('complete-key', {
      statusCode: 200,
      body: { decision: 'allow' },
    });

    expect(updated?.status).toBe('completed');
    expect(updated?.response?.statusCode).toBe(200);
  });
});
