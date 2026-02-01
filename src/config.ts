import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
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

export const config = {
  // Server
  port: parseInt(process.env.GATEKEEPER_PORT || '3847', 10),
  baseUrl: process.env.BASE_URL || 'http://localhost:3847',

  // Security
  secret: process.env.GATEKEEPER_SECRET || '',
  approvalExpiryMs: 60 * 60 * 1000, // 1 hour

  // Paths
  policyPath: process.env.POLICY_PATH || join(projectRoot, 'policy.yaml'),
  dataDir: process.env.DATA_DIR || join(projectRoot, 'data'),

  // Slack
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || '',

  // Version
  version: loadVersion(),

  // Derived paths
  get approvalsDir() {
    return join(this.dataDir, 'approvals');
  },
  get auditDir() {
    return join(this.dataDir, 'audit');
  },
};

// Validate required config
export function validateConfig(): void {
  if (!config.secret || config.secret.length < 32) {
    console.error('ERROR: GATEKEEPER_SECRET must be set and at least 32 characters');
    process.exit(1);
  }
}
