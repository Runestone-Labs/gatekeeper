import {
  appendFileSync,
  closeSync,
  mkdirSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { AuditEntry, ModelCallUsage, UsageFilter, UsageRow, UsageSummary } from '../types.js';
import { AuditSink } from './types.js';
import { canonicalize, computeHash } from '../utils.js';

export interface AuditVerificationResult {
  valid: boolean;
  chainedEntries: number;
  legacyEntries: number;
  lastSequence: number;
  lastEntryHash: string | null;
  errors: string[];
}

function listAuditFiles(auditDir: string): string[] {
  if (!existsSync(auditDir)) return [];
  return readdirSync(auditDir)
    .filter((file) => file.endsWith('.jsonl'))
    .sort();
}

function entryHash(entry: AuditEntry): string {
  const { entryHash: _entryHash, ...hashable } = entry;
  // Hash the exact JSON representation that is persisted. JSON.stringify
  // omits undefined optional fields, so remove them before canonicalization.
  const persisted = JSON.parse(JSON.stringify(hashable)) as Omit<AuditEntry, 'entryHash'>;
  return `sha256:${computeHash(canonicalize(persisted))}`;
}

export function verifyAuditDirectory(auditDir = config.auditDir): AuditVerificationResult {
  const errors: string[] = [];
  let expectedSequence = 1;
  let previousHash: string | null = null;
  let chainedEntries = 0;
  let legacyEntries = 0;

  for (const file of listAuditFiles(auditDir)) {
    const lines = readFileSync(join(auditDir, file), 'utf-8').split('\n');
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].trim()) continue;
      let entry: AuditEntry;
      try {
        entry = JSON.parse(lines[index]) as AuditEntry;
      } catch {
        errors.push(`${file}:${index + 1}: invalid JSON`);
        continue;
      }

      if (entry.sequence === undefined || entry.entryHash === undefined) {
        legacyEntries++;
        continue;
      }
      chainedEntries++;
      if (entry.sequence !== expectedSequence) {
        errors.push(
          `${file}:${index + 1}: expected sequence ${expectedSequence}, got ${entry.sequence}`
        );
      }
      if ((entry.previousEntryHash ?? null) !== previousHash) {
        errors.push(`${file}:${index + 1}: previous-entry hash mismatch`);
      }
      const calculated = entryHash(entry);
      if (entry.entryHash !== calculated) {
        errors.push(`${file}:${index + 1}: entry hash mismatch`);
      }
      expectedSequence = entry.sequence + 1;
      previousHash = entry.entryHash;
    }
  }

  return {
    valid: errors.length === 0,
    chainedEntries,
    legacyEntries,
    lastSequence: expectedSequence - 1,
    lastEntryHash: previousHash,
    errors,
  };
}

/** Total billable tokens for a model call (input + output + cache tiers), or null. */
export function sumUsageTokens(usage: ModelCallUsage | undefined): number | null {
  if (!usage) return null;
  return (
    usage.inputTokens +
    usage.outputTokens +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheCreationTokens ?? 0)
  );
}

/**
 * JSONL audit sink - writes audit entries to daily log files.
 * Entries are append-only and never mutated.
 */
export class JsonlAuditSink implements AuditSink {
  name = 'jsonl';

  async write(entry: AuditEntry): Promise<void> {
    // Ensure audit directory exists
    if (!existsSync(config.auditDir)) {
      mkdirSync(config.auditDir, { recursive: true });
    }

    // Get today's date for the filename
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const logFile = join(config.auditDir, `${today}.jsonl`);

    const releaseLock = acquireChainLock(config.auditDir);
    try {
      const verified = verifyAuditDirectory(config.auditDir);
      if (!verified.valid) {
        throw new Error(`Refusing to extend invalid audit chain: ${verified.errors[0]}`);
      }
      entry.sequence = verified.lastSequence + 1;
      entry.previousEntryHash = verified.lastEntryHash;
      entry.entryHash = entryHash(entry);

      // Append while holding a cross-process lock so multiple daemon/test
      // workers cannot independently assign the same sequence number.
      const line = JSON.stringify(entry) + '\n';
      appendFileSync(logFile, line, 'utf-8');
    } finally {
      releaseLock();
    }
  }

  async flush(): Promise<void> {
    // No buffering in the file-based implementation
  }

  /**
   * Aggregate call counts and durations by scanning the daily .jsonl files.
   * Linear in the number of entries in the window — fine for typical use
   * (days to weeks) but not intended for long retention windows.
   */
  async summarizeUsage(filter: UsageFilter): Promise<UsageSummary> {
    if (!existsSync(config.auditDir)) {
      return {
        rows: [],
        totalCalls: 0,
        distinctActors: 0,
        distinctTools: 0,
        filter,
        generatedAt: new Date().toISOString(),
      };
    }

    const sinceDate = filter.since ? new Date(filter.since) : null;
    const untilDate = filter.until ? new Date(filter.until) : null;
    const files = listAuditFiles(config.auditDir);

    // Key shape: `${actorName}\x01${actorRole}\x01${tool}\x01${day}`
    const buckets = new Map<
      string,
      {
        actorName: string | null;
        actorRole: string | null;
        tool: string;
        day: string;
        callCount: number;
        totalDurationMs: number | null;
        decisions: Record<string, number>;
        totalCostUsd: number | null;
        totalTokens: number | null;
      }
    >();

    for (const file of files) {
      const fileDate = file.slice(0, 10); // YYYY-MM-DD prefix
      if (sinceDate && fileDate < sinceDate.toISOString().slice(0, 10)) continue;
      if (untilDate && fileDate > untilDate.toISOString().slice(0, 10)) continue;

      let content: string;
      try {
        content = readFileSync(join(config.auditDir, file), 'utf-8');
      } catch {
        continue;
      }

      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        let entry: AuditEntry;
        try {
          entry = JSON.parse(line) as AuditEntry;
        } catch {
          continue;
        }

        const ts = new Date(entry.timestamp);
        if (sinceDate && ts < sinceDate) continue;
        if (untilDate && ts >= untilDate) continue;

        const actorName = entry.actor?.name ?? null;
        const actorRole = entry.actor?.role ?? null;
        if (filter.actorName && actorName !== filter.actorName) continue;
        if (filter.actorRole && actorRole !== filter.actorRole) continue;
        if (filter.tool && entry.tool !== filter.tool) continue;
        if (filter.runId && entry.actor?.runId !== filter.runId) continue;

        const day = entry.timestamp.slice(0, 10);
        const key = `${actorName ?? ''}\x01${actorRole ?? ''}\x01${entry.tool}\x01${day}`;
        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = {
            actorName,
            actorRole,
            tool: entry.tool,
            day,
            callCount: 0,
            totalDurationMs: null,
            decisions: {},
            totalCostUsd: null,
            totalTokens: null,
          };
          buckets.set(key, bucket);
        }
        bucket.callCount++;
        bucket.decisions[entry.decision] = (bucket.decisions[entry.decision] ?? 0) + 1;
        const dur = entry.executionReceipt?.durationMs;
        if (typeof dur === 'number') {
          bucket.totalDurationMs = (bucket.totalDurationMs ?? 0) + dur;
        }
        if (typeof entry.costUsd === 'number') {
          bucket.totalCostUsd = (bucket.totalCostUsd ?? 0) + entry.costUsd;
        }
        const tokens = sumUsageTokens(entry.usage);
        if (tokens != null) {
          bucket.totalTokens = (bucket.totalTokens ?? 0) + tokens;
        }
      }
    }

    const limit = Math.max(1, Math.min(filter.limit ?? 500, 5000));
    const rows: UsageRow[] = [...buckets.values()]
      .sort((a, b) => b.callCount - a.callCount || (a.day < b.day ? 1 : -1))
      .slice(0, limit);

    const distinctActors = new Set(rows.map((r) => `${r.actorName ?? ''}:${r.actorRole ?? ''}`))
      .size;
    const distinctTools = new Set(rows.map((r) => r.tool)).size;
    const totalCalls = rows.reduce((sum, r) => sum + r.callCount, 0);

    return {
      rows,
      totalCalls,
      distinctActors,
      distinctTools,
      filter,
      generatedAt: new Date().toISOString(),
    };
  }
}

function acquireChainLock(auditDir: string): () => void {
  const path = join(auditDir, '.chain.lock');
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      const descriptor = openSync(path, 'wx', 0o600);
      return () => {
        closeSync(descriptor);
        try {
          unlinkSync(path);
        } catch {
          // Another recovery path may already have removed a stale lock.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(path).mtimeMs > 30_000) {
          unlinkSync(path);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) throw new Error('Timed out acquiring audit chain lock');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}
