import { appendFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { AuditEntry, UsageFilter, UsageRow, UsageSummary } from '../types.js';
import { AuditSink } from './types.js';

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

    // Append to log file (JSONL format)
    const line = JSON.stringify(entry) + '\n';

    try {
      appendFileSync(logFile, line, 'utf-8');
    } catch (err) {
      // Log to stderr if we can't write to the audit log
      console.error('Failed to write audit log:', err);
      console.error('Entry:', entry);
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
    const files = readdirSync(config.auditDir).filter((f) => f.endsWith('.jsonl'));

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
          };
          buckets.set(key, bucket);
        }
        bucket.callCount++;
        bucket.decisions[entry.decision] = (bucket.decisions[entry.decision] ?? 0) + 1;
        const dur = entry.executionReceipt?.durationMs;
        if (typeof dur === 'number') {
          bucket.totalDurationMs = (bucket.totalDurationMs ?? 0) + dur;
        }
      }
    }

    const limit = Math.max(1, Math.min(filter.limit ?? 500, 5000));
    const rows: UsageRow[] = [...buckets.values()]
      .sort((a, b) => b.callCount - a.callCount || (a.day < b.day ? 1 : -1))
      .slice(0, limit);

    const distinctActors = new Set(
      rows.map((r) => `${r.actorName ?? ''}:${r.actorRole ?? ''}`),
    ).size;
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
