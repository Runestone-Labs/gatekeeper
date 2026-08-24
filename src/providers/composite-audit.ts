import type { AuditEntry, UsageFilter, UsageSummary } from '../types.js';
import type { AuditSink } from './types.js';

/**
 * Writes to the authoritative local sink first. Secondary failures are isolated
 * because Cloud is a convenience copy, never the execution or forensic record.
 */
export class CompositeAuditSink implements AuditSink {
  readonly name: string;

  constructor(
    private readonly primary: AuditSink,
    private readonly secondaries: AuditSink[]
  ) {
    this.name = `${primary.name}+${secondaries.map((sink) => sink.name).join('+')}`;
  }

  async write(entry: AuditEntry): Promise<void> {
    await this.primary.write(entry);
    await Promise.allSettled(this.secondaries.map((sink) => sink.write(entry)));
  }

  async flush(): Promise<void> {
    await this.primary.flush?.();
    await Promise.allSettled(this.secondaries.map((sink) => sink.flush?.()));
  }

  summarizeUsage(filter: UsageFilter): Promise<UsageSummary> {
    if (!this.primary.summarizeUsage) {
      throw new Error(`Primary audit sink ${this.primary.name} does not support usage summaries`);
    }
    return this.primary.summarizeUsage(filter);
  }
}
