import { ApprovalProvider, AuditSink, PolicySource } from './types.js';
import { PendingApproval, AuditEntry, Policy } from '../types.js';
import { config } from '../config.js';

/**
 * Runestone Control Plane - Approval Provider
 *
 * Delegates approval workflows to a Runestone Control Plane instance.
 * The control plane handles:
 * - Web-based approval UI
 * - Mobile push notifications
 * - Team approval routing
 * - Approval audit history
 *
 * Configure with:
 *   RUNESTONE_API_URL=http://127.0.0.1:3848
 *   RUNESTONE_API_KEY=your-api-key (optional for dev)
 */
export class RunestoneCloudApproval implements ApprovalProvider {
  name = 'runestone';

  async requestApproval(
    approval: PendingApproval,
    urls: { approveUrl: string; denyUrl: string }
  ): Promise<boolean> {
    if (!config.runestoneApiUrl) {
      throw new Error(
        'RUNESTONE_API_URL not configured. ' + 'Set RUNESTONE_API_URL to your control plane URL.'
      );
    }

    const payload = {
      id: approval.id,
      toolName: approval.toolName,
      args: approval.args,
      actor: approval.actor,
      context: approval.context,
      createdAt: approval.createdAt,
      expiresAt: approval.expiresAt,
      callbacks: {
        approveUrl: urls.approveUrl,
        denyUrl: urls.denyUrl,
      },
    };

    const response = await fetch(`${config.runestoneApiUrl}/approvals`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.runestoneApiKey && { Authorization: `Bearer ${config.runestoneApiKey}` }),
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Control plane rejected approval request: ${response.status} ${text}`);
    }

    return true;
  }

  async notifyResult(
    approval: PendingApproval,
    action: 'approved' | 'denied',
    result?: string
  ): Promise<void> {
    if (!config.runestoneApiUrl) {
      return; // Silently skip if not configured
    }

    const payload = {
      action,
      result,
      completedAt: new Date().toISOString(),
    };

    // Fire and forget - don't fail if notification fails
    try {
      await fetch(`${config.runestoneApiUrl}/approvals/${approval.id}/result`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.runestoneApiKey && { Authorization: `Bearer ${config.runestoneApiKey}` }),
        },
        body: JSON.stringify(payload),
      });
    } catch {
      // Notification is best-effort
    }
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
