import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { AuditEntry } from '../types.js';
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
}
