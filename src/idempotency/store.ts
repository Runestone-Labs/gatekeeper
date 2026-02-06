import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { computeHash } from '../utils.js';

export interface IdempotencyRecord {
  key: string;
  requestId: string;
  toolName: string;
  argsHash: string;
  status: 'pending' | 'completed';
  response?: {
    statusCode: number;
    body: Record<string, unknown>;
  };
  createdAt: string;
  updatedAt: string;
}

const recordCache = new Map<string, IdempotencyRecord>();

function ensureIdempotencyDir(): void {
  if (!existsSync(config.idempotencyDir)) {
    mkdirSync(config.idempotencyDir, { recursive: true });
  }
}

function getRecordPath(key: string): string {
  return join(config.idempotencyDir, `${computeHash(key)}.json`);
}

export function getIdempotencyRecord(key: string): IdempotencyRecord | null {
  if (recordCache.has(key)) {
    const cached = recordCache.get(key)!;
    const path = getRecordPath(key);
    if (!existsSync(path)) {
      recordCache.delete(key);
      return null;
    }
    return cached;
  }

  ensureIdempotencyDir();
  const path = getRecordPath(key);

  if (!existsSync(path)) {
    return null;
  }

  const content = readFileSync(path, 'utf-8');
  const record = JSON.parse(content) as IdempotencyRecord;
  recordCache.set(key, record);
  return record;
}

export function createPendingRecord(params: {
  key: string;
  requestId: string;
  toolName: string;
  argsHash: string;
}): IdempotencyRecord {
  const now = new Date().toISOString();
  const record: IdempotencyRecord = {
    key: params.key,
    requestId: params.requestId,
    toolName: params.toolName,
    argsHash: params.argsHash,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };

  saveRecord(record);
  return record;
}

export function completeIdempotencyRecord(
  key: string,
  response: { statusCode: number; body: Record<string, unknown> }
): IdempotencyRecord | null {
  const record = getIdempotencyRecord(key);
  if (!record) return null;

  const updated: IdempotencyRecord = {
    ...record,
    status: 'completed',
    response,
    updatedAt: new Date().toISOString(),
  };

  saveRecord(updated);
  return updated;
}

function saveRecord(record: IdempotencyRecord): void {
  ensureIdempotencyDir();
  const path = getRecordPath(record.key);
  writeFileSync(path, JSON.stringify(record, null, 2), 'utf-8');
  recordCache.set(record.key, record);
}
