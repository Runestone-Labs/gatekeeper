import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

// Load version from package.json
function loadVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export type ApprovalProviderType = 'local' | 'slack' | 'runestone';
export type AuditSinkType = 'jsonl' | 'postgres' | 'runestone';
export type PolicySourceType = 'yaml' | 'runestone';

type CloudFileConfig = {
  apiUrl?: string;
  instanceId?: string;
  instanceToken?: string;
};

function loadCloudFileConfig(): CloudFileConfig {
  const file =
    process.env.GATEKEEPER_CLOUD_CONFIG || join(homedir(), '.config', 'gatekeeper', 'cloud.json');
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as CloudFileConfig;
  } catch {
    return {};
  }
}

const cloudFileConfig = loadCloudFileConfig();

export const config = {
  // Server
  port: parseInt(process.env.GATEKEEPER_PORT || '3847', 10),
  host: process.env.GATEKEEPER_HOST || '127.0.0.1',
  baseUrl: process.env.BASE_URL || 'http://127.0.0.1:3847',

  // Security
  secret: process.env.GATEKEEPER_SECRET || '',
  // Approval TTL. The 1h default suits console/Slack flows where the approver is
  // near-synchronous; interactive setups (menu-bar app) should raise it — a TTL
  // shorter than the human's response time silently converts every hold into an
  // expiry (see 2026-05-29: all four production holds died this way).
  approvalExpiryMs: parseInt(process.env.APPROVAL_EXPIRY_MS || String(60 * 60 * 1000), 10),

  // Paths
  policyPath: process.env.POLICY_PATH || join(projectRoot, 'policy.yaml'),
  dataDir: process.env.DATA_DIR || join(projectRoot, 'data'),

  // Database (for MemoryGraph)
  databaseUrl: process.env.DATABASE_URL || '',

  // Memory module (optional — requires DATABASE_URL)
  enableMemory: process.env.ENABLE_MEMORY
    ? process.env.ENABLE_MEMORY === 'true'
    : !!process.env.DATABASE_URL,

  // Slack
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || '',

  // Runestone Cloud
  runestoneApiUrl: process.env.RUNESTONE_API_URL || cloudFileConfig.apiUrl || '',
  runestoneApiKey: process.env.RUNESTONE_API_KEY || cloudFileConfig.instanceToken || '',
  runestoneInstanceId: process.env.RUNESTONE_INSTANCE_ID || cloudFileConfig.instanceId || '',
  cloudPollIntervalMs: Math.max(500, parseInt(process.env.CLOUD_POLL_INTERVAL_MS || '2000', 10)),
  cloudRequestTimeoutMs: Math.max(
    1000,
    parseInt(process.env.CLOUD_REQUEST_TIMEOUT_MS || '15000', 10)
  ),
  cloudSpoolMaxBytes: Math.max(
    1024 * 1024,
    parseInt(process.env.CLOUD_SPOOL_MAX_BYTES || String(25 * 1024 * 1024), 10)
  ),
  cloudCustomSummaryFields: (process.env.CLOUD_CUSTOM_SUMMARY_FIELDS || '')
    .split(',')
    .map((field) => field.trim())
    .filter(Boolean),

  // Anthropic model-call proxy — lets agents (e.g. the OpenClaw Agent SDK engine)
  // route /v1/messages through gatekeeper for policy + audit instead of calling
  // Anthropic directly. Off by default. When `anthropicApiKey` is set here, the
  // proxy injects it (so the key can live only in gatekeeper); otherwise it
  // forwards the caller-provided key.
  enableAnthropicProxy: process.env.ENABLE_ANTHROPIC_PROXY === 'true',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',

  // Provider selection
  approvalProvider: (process.env.APPROVAL_PROVIDER ||
    (cloudFileConfig.instanceToken && cloudFileConfig.instanceId
      ? 'runestone'
      : 'local')) as ApprovalProviderType,
  auditSink: (process.env.AUDIT_SINK || 'jsonl') as AuditSinkType,
  policySource: (process.env.POLICY_SOURCE || 'yaml') as PolicySourceType,

  // Demo mode - exposes approval URLs in responses
  demoMode: process.env.DEMO_MODE === 'true',

  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',

  // Version
  version: loadVersion(),

  // Derived paths
  get approvalsDir() {
    return join(this.dataDir, 'approvals');
  },
  get auditDir() {
    return join(this.dataDir, 'audit');
  },
  get idempotencyDir() {
    return join(this.dataDir, 'idempotency');
  },
  get cloudDir() {
    return join(this.dataDir, 'cloud');
  },
  get cloudSpoolPath() {
    return join(this.cloudDir, 'events-spool.jsonl');
  },
  get cloudPolicyCachePath() {
    return join(this.cloudDir, 'policy-last-known-good.json');
  },
  get cloudChainStatePath() {
    return join(this.cloudDir, 'events-chain-state.json');
  },
};

// Validate required config
export function validateConfig(): void {
  if (!config.secret || config.secret.length < 32) {
    console.error('ERROR: GATEKEEPER_SECRET must be set and at least 32 characters');
    process.exit(1);
  }
}
