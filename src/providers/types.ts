import { PendingApproval, AuditEntry, Policy } from '../types.js';

/**
 * ApprovalProvider interface for sending approval notifications.
 * Implementations can use Slack, Discord, SMS, email, or any other channel.
 */
export interface ApprovalProvider {
  name: string;

  /**
   * Send an approval request notification.
   * Returns the URLs that the approver can use to approve/deny.
   */
  requestApproval(approval: PendingApproval, urls: { approveUrl: string; denyUrl: string }): Promise<boolean>;

  /**
   * Optionally notify about the result of an approval action.
   */
  notifyResult?(approval: PendingApproval, action: 'approved' | 'denied', result?: string): Promise<void>;
}

/**
 * AuditSink interface for writing audit log entries.
 * Implementations can write to files, databases, or cloud services.
 */
export interface AuditSink {
  name: string;

  /**
   * Write an audit entry.
   */
  write(entry: AuditEntry): Promise<void>;

  /**
   * Optionally flush any buffered entries.
   */
  flush?(): Promise<void>;
}

/**
 * PolicySource interface for loading policy configuration.
 * Implementations can load from YAML files, databases, or cloud services.
 */
export interface PolicySource {
  name: string;

  /**
   * Load and return the policy.
   */
  load(): Promise<Policy>;

  /**
   * Get a hash of the current policy (for audit logging).
   */
  getHash(): string;

  /**
   * Optionally register a callback for policy changes.
   */
  onChange?(callback: () => void): void;
}
