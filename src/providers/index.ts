import { config } from '../config.js';
import { ApprovalProvider, AuditSink, PolicySource } from './types.js';
import { LocalApprovalProvider } from './local-approval.js';
import { SlackApprovalProvider } from './slack-approval.js';
import { JsonlAuditSink } from './jsonl-audit.js';
import { PostgresAuditSink } from './postgres-audit.js';
import { YamlPolicySource } from './yaml-policy.js';
import { CompositeAuditSink } from './composite-audit.js';
import {
  RunestoneCloudApproval,
  RunestoneCloudAudit,
  RunestoneCloudPolicy,
} from './runestone-cloud.js';

// Re-export types
export type { ApprovalProvider, AuditSink, PolicySource } from './types.js';

// Singleton instances
let approvalProvider: ApprovalProvider | null = null;
let auditSink: AuditSink | null = null;
let policySource: PolicySource | null = null;

/**
 * Get the configured approval provider.
 * Creates the provider on first call based on APPROVAL_PROVIDER env var.
 */
export function getApprovalProvider(): ApprovalProvider {
  if (approvalProvider) {
    return approvalProvider;
  }

  switch (config.approvalProvider) {
    case 'slack':
      approvalProvider = new SlackApprovalProvider();
      break;
    case 'runestone':
      approvalProvider = new RunestoneCloudApproval();
      break;
    case 'local':
    default:
      approvalProvider = new LocalApprovalProvider();
      break;
  }

  return approvalProvider;
}

/**
 * Get the configured audit sink.
 * Creates the sink on first call based on AUDIT_SINK env var.
 */
export function getAuditSink(): AuditSink {
  if (auditSink) {
    return auditSink;
  }

  let primary: AuditSink;
  switch (config.auditSink) {
    case 'postgres':
      primary = new PostgresAuditSink();
      break;
    case 'runestone':
      // Backwards-compatible migration: Cloud is never authoritative.
      primary = new JsonlAuditSink();
      break;
    case 'jsonl':
    default:
      primary = new JsonlAuditSink();
      break;
  }

  auditSink =
    config.runestoneApiUrl && config.runestoneApiKey && config.runestoneInstanceId
      ? new CompositeAuditSink(primary, [new RunestoneCloudAudit()])
      : primary;

  return auditSink;
}

/**
 * Get the configured policy source.
 * Creates the source on first call based on POLICY_SOURCE env var.
 */
export function getPolicySource(): PolicySource {
  if (policySource) {
    return policySource;
  }

  switch (config.policySource) {
    case 'runestone':
      policySource = new RunestoneCloudPolicy();
      break;
    case 'yaml':
    default:
      policySource = new YamlPolicySource(config.policyPath);
      break;
  }

  return policySource;
}

/**
 * Reset all providers (for testing).
 */
export function resetProviders(): void {
  approvalProvider = null;
  auditSink = null;
  policySource = null;
}
