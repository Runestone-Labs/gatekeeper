import { ApprovalProvider, AuditSink, PolicySource } from './types.js';
import { PendingApproval, AuditEntry, Policy } from '../types.js';

/**
 * Runestone Control Plane - Approval Provider
 *
 * Coming soon: Hosted approval workflows with:
 * - Web-based approval UI
 * - Mobile push notifications
 * - Team approval routing
 * - Approval audit history
 *
 * Contact: enterprise@runestone.dev
 */
export class RunestoneCloudApproval implements ApprovalProvider {
  name = 'runestone';

  async requestApproval(
    _approval: PendingApproval,
    _urls: { approveUrl: string; denyUrl: string }
  ): Promise<boolean> {
    // TODO: Connect to Runestone Control Plane API
    throw new Error(
      'Runestone Cloud approval provider not yet implemented. ' +
        'Contact enterprise@runestone.dev for early access.'
    );
  }

  async notifyResult(
    _approval: PendingApproval,
    _action: 'approved' | 'denied',
    _result?: string
  ): Promise<void> {
    // TODO: Connect to Runestone Control Plane API
  }
}

/**
 * Runestone Control Plane - Audit Sink
 *
 * Coming soon: Cloud audit storage with:
 * - Full-text search across all audit logs
 * - Compliance exports (SOC2, HIPAA)
 * - Retention policies
 * - Alerting and anomaly detection
 *
 * Contact: enterprise@runestone.dev
 */
export class RunestoneCloudAudit implements AuditSink {
  name = 'runestone';

  async write(_entry: AuditEntry): Promise<void> {
    // TODO: Stream to Runestone for retention + search
    throw new Error(
      'Runestone Cloud audit sink not yet implemented. ' +
        'Contact enterprise@runestone.dev for early access.'
    );
  }

  async flush(): Promise<void> {
    // TODO: Flush buffered entries to Runestone
  }
}

/**
 * Runestone Control Plane - Policy Source
 *
 * Coming soon: Managed policy configuration with:
 * - Version-controlled policy history
 * - Policy templates for common use cases
 * - A/B testing for policy changes
 * - Multi-environment policy management
 *
 * Contact: enterprise@runestone.dev
 */
export class RunestoneCloudPolicy implements PolicySource {
  name = 'runestone';

  async load(): Promise<Policy> {
    // TODO: Fetch policy from Runestone Control Plane
    throw new Error(
      'Runestone Cloud policy source not yet implemented. ' +
        'Contact enterprise@runestone.dev for early access.'
    );
  }

  getHash(): string {
    // TODO: Return hash from Runestone Control Plane
    throw new Error('Policy not loaded');
  }

  onChange(_callback: () => void): void {
    // TODO: Subscribe to policy change events via WebSocket
  }
}
