import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyAuditDirectory } from '../../src/providers/jsonl-audit.js';
import { canonicalize, computeHash } from '../../src/utils.js';

function hashed(entry: Record<string, unknown>): Record<string, unknown> {
  return { ...entry, entryHash: `sha256:${computeHash(canonicalize(entry))}` };
}

describe('tamper-evident audit receipts', () => {
  it('detects sequence gaps and modified entries', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gatekeeper-audit-'));
    const first = hashed({
      timestamp: '2026-08-23T12:00:00.000Z',
      sequence: 1,
      previousEntryHash: null,
      tool: 'shell.exec',
    });
    const second = hashed({
      timestamp: '2026-08-23T12:01:00.000Z',
      sequence: 2,
      previousEntryHash: first.entryHash,
      tool: 'files.write',
    });
    const path = join(directory, '2026-08-23.jsonl');
    writeFileSync(path, `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);
    expect(verifyAuditDirectory(directory)).toMatchObject({
      valid: true,
      chainedEntries: 2,
      lastSequence: 2,
    });

    const tampered = readFileSync(path, 'utf-8').replace('files.write', 'shell.exec');
    writeFileSync(path, tampered);
    expect(verifyAuditDirectory(directory).valid).toBe(false);
    expect(verifyAuditDirectory(directory).errors).toContain(
      '2026-08-23.jsonl:2: entry hash mismatch'
    );
  });
});
