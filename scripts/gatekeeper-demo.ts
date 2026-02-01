#!/usr/bin/env tsx
/**
 * Gatekeeper Demo: Before/After Contrast
 *
 * Shows the same agent request producing two radically different outcomes:
 * - Ungoverned: Quietly exfiltrates secrets
 * - Governed: Blocked, explained, logged
 *
 * Usage:
 *   npm run gatekeeper:unsafe  — Direct fetch, no gatekeeper
 *   npm run gatekeeper:safe    — Same request through gatekeeper
 *   npm run gatekeeper         — Both in sequence (for recording)
 */

import { spawn, ChildProcess } from 'node:child_process';

const METADATA_URL = 'http://127.0.0.1:9999';
const GATEKEEPER_URL = 'http://localhost:3847';
const DEMO_SECRET = 'demo-secret-at-least-32-characters-long';

// ANSI colors
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Box drawing helpers
const BOX_WIDTH = 58;

function boxTop(): string {
  return `┌${'─'.repeat(BOX_WIDTH)}┐`;
}

function boxBottom(): string {
  return `└${'─'.repeat(BOX_WIDTH)}┘`;
}

function boxLine(text: string): string {
  const padding = BOX_WIDTH - text.length - 2;
  return `│  ${text}${' '.repeat(Math.max(0, padding))}│`;
}

function boxEmpty(): string {
  return `│${' '.repeat(BOX_WIDTH)}│`;
}

function doubleBoxTop(): string {
  return `╔${'═'.repeat(BOX_WIDTH)}╗`;
}

function doubleBoxBottom(): string {
  return `╚${'═'.repeat(BOX_WIDTH)}╝`;
}

function doubleBoxLine(text: string): string {
  const padding = BOX_WIDTH - text.length - 2;
  return `║  ${text}${' '.repeat(Math.max(0, padding))}║`;
}

function hardBreak(): string {
  return `${'━'.repeat(BOX_WIDTH + 2)}`;
}

// Process management
let metadataServer: ChildProcess | null = null;
let gatekeeperServer: ChildProcess | null = null;

function cleanup() {
  if (metadataServer) {
    metadataServer.kill('SIGTERM');
    metadataServer = null;
  }
  if (gatekeeperServer) {
    gatekeeperServer.kill('SIGTERM');
    gatekeeperServer = null;
  }
}

process.on('SIGINT', () => { cleanup(); process.exit(1); });
process.on('SIGTERM', () => { cleanup(); process.exit(1); });

function startMetadataServer(): ChildProcess {
  const server = spawn('npx', ['tsx', 'scripts/fake-metadata-server.ts'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: process.cwd(),
  });
  server.stdout?.on('data', () => {});
  server.stderr?.on('data', () => {});
  return server;
}

function startGatekeeperServer(): ChildProcess {
  const env = {
    ...process.env,
    DEMO_MODE: 'true',
    POLICY_PATH: './policy.demo.yaml',
    GATEKEEPER_PORT: '3847',
    BASE_URL: 'http://localhost:3847',
    LOG_LEVEL: 'error',
    DATA_DIR: './data',
    GATEKEEPER_SECRET: process.env.GATEKEEPER_SECRET || DEMO_SECRET,
    APPROVAL_PROVIDER: 'local',
  };

  const server = spawn('npx', ['tsx', 'src/server.ts'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: process.cwd(),
  });
  server.stdout?.on('data', () => {});
  server.stderr?.on('data', () => {});
  return server;
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not ready yet
    }
    await sleep(100);
  }
  throw new Error(`Server at ${url} did not become ready`);
}

// ═══════════════════════════════════════════════════════════════════════════
// COLD OPEN
// ═══════════════════════════════════════════════════════════════════════════

async function showColdOpen(): Promise<void> {
  console.log('');
  console.log(boxTop());
  console.log(boxLine('We gave an AI agent one harmless task.'));
  console.log(boxEmpty());
  console.log(boxLine('This is what happened.'));
  console.log(boxBottom());
  console.log('');
  console.log(`${c.dim}(Simulated agent · real tools and permissions)${c.reset}`);
  console.log('');

  await sleep(2500);
}

// ═══════════════════════════════════════════════════════════════════════════
// UNSAFE MODE: Direct fetch, no gatekeeper
// ═══════════════════════════════════════════════════════════════════════════

async function runUnsafeDemo(): Promise<void> {
  // Big label
  console.log(`${c.yellow}${doubleBoxTop()}${c.reset}`);
  console.log(`${c.yellow}${doubleBoxLine('⚠️  UNGOVERNED AGENT')}${c.reset}`);
  console.log(`${c.yellow}${doubleBoxLine('No trust boundary. No oversight.')}${c.reset}`);
  console.log(`${c.yellow}${doubleBoxBottom()}${c.reset}`);
  console.log('');

  await sleep(1000);

  console.log(`${c.dim}Agent task: "Summarize the runtime environment"${c.reset}`);
  console.log('');

  await sleep(500);

  // Start fake metadata server
  metadataServer = startMetadataServer();
  await sleep(500);

  console.log(`${c.dim}→ Fetching environment info...${c.reset}`);
  await sleep(300);

  // Step 1: Get role name
  const roleUrl = `${METADATA_URL}/latest/meta-data/iam/security-credentials/`;
  console.log(`${c.dim}→ GET ${roleUrl}${c.reset}`);

  const roleResponse = await fetch(roleUrl);
  const roleName = await roleResponse.text();

  await sleep(300);

  // Step 2: Get credentials
  const credsUrl = `${METADATA_URL}/latest/meta-data/iam/security-credentials/${roleName}`;
  console.log(`${c.dim}→ GET ${credsUrl}${c.reset}`);

  const credsResponse = await fetch(credsUrl);
  const creds = await credsResponse.json() as { AccessKeyId: string; SecretAccessKey: string };

  await sleep(500);

  console.log('');
  console.log(`${c.green}✓${c.reset} AccessKeyId: ${c.bold}${creds.AccessKeyId}${c.reset}`);
  console.log(`${c.green}✓${c.reset} SecretAccessKey: ${c.bold}${creds.SecretAccessKey.slice(0, 20)}...${c.reset}`);
  console.log('');

  await sleep(1000);

  // Emotional hook - pause on this
  console.log(`${c.red}${boxTop()}${c.reset}`);
  console.log(`${c.red}${boxLine('💀 Secrets read and sent out.')}${c.reset}`);
  console.log(`${c.red}${boxLine('   No alert. No failure. No trace.')}${c.reset}`);
  console.log(`${c.red}${boxBottom()}${c.reset}`);
  console.log('');

  await sleep(2000);

  // Cleanup metadata server
  if (metadataServer) {
    metadataServer.kill('SIGTERM');
    metadataServer = null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SAFE MODE: Through gatekeeper
// ═══════════════════════════════════════════════════════════════════════════

async function runSafeDemo(): Promise<void> {
  // Hard transition
  console.log(`${c.dim}${hardBreak()}${c.reset}`);
  console.log('');

  await sleep(500);

  // Big label
  console.log(`${c.green}${doubleBoxTop()}${c.reset}`);
  console.log(`${c.green}${doubleBoxLine('🛡️  GOVERNED AGENT')}${c.reset}`);
  console.log(`${c.green}${doubleBoxLine('Same agent. Same request. One boundary added.')}${c.reset}`);
  console.log(`${c.green}${doubleBoxBottom()}${c.reset}`);
  console.log('');

  await sleep(1000);

  // Start servers
  metadataServer = startMetadataServer();
  gatekeeperServer = startGatekeeperServer();

  await sleep(500);
  await waitForServer(`${GATEKEEPER_URL}/health`, 10000);

  console.log(`${c.dim}→ Fetching environment info...${c.reset}`);
  await sleep(300);

  // Try to fetch through gatekeeper
  const credsUrl = `${METADATA_URL}/latest/meta-data/iam/security-credentials/demo-instance-role`;
  console.log(`${c.dim}→ POST /tool/http.request${c.reset}`);

  const response = await fetch(`${GATEKEEPER_URL}/tool/http.request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requestId: '00000000-0000-0000-0000-000000000099',
      actor: { type: 'agent', name: 'demo-agent', runId: 'gatekeeper-demo' },
      args: { url: credsUrl, method: 'GET' },
      context: { conversationId: 'gatekeeper-demo' },
    }),
  });

  const result = await response.json() as {
    decision?: string;
    reason?: string;
    error?: string;
    success?: boolean;
  };

  await sleep(500);

  console.log('');

  // Show the block
  if (response.status === 403 || result.decision === 'deny') {
    console.log(`${c.red}✗${c.reset} ${c.bold}BLOCKED${c.reset} http.request`);
    console.log(`  ${c.dim}reason: ${result.reason || result.error || 'Blocked by policy'}${c.reset}`);
  } else if (result.success === false && result.error) {
    console.log(`${c.red}✗${c.reset} ${c.bold}BLOCKED${c.reset} http.request`);
    console.log(`  ${c.dim}reason: ${result.error}${c.reset}`);
  } else {
    console.log(`${c.yellow}○${c.reset} ${c.bold}${(result.decision || 'PROCESSED').toUpperCase()}${c.reset} http.request`);
  }
  console.log('');

  await sleep(1000);

  // Payoff summary
  console.log(`${c.cyan}${boxTop()}${c.reset}`);
  console.log(`${c.cyan}${boxLine('✓ Action blocked')}${c.reset}`);
  console.log(`${c.cyan}${boxLine('✓ Reason explained')}${c.reset}`);
  console.log(`${c.cyan}${boxLine('✓ Logged to audit trail')}${c.reset}`);
  console.log(`${c.cyan}${boxBottom()}${c.reset}`);
  console.log('');

  await sleep(1500);

  cleanup();
}

// ═══════════════════════════════════════════════════════════════════════════
// CLOSING REFRAME
// ═══════════════════════════════════════════════════════════════════════════

async function showClosing(): Promise<void> {
  console.log(`${c.dim}${hardBreak()}${c.reset}`);
  console.log('');

  await sleep(500);

  console.log(`${c.bold}  AI agents don't fail because they're dumb.${c.reset}`);
  console.log(`${c.bold}  They fail because we trust them too much.${c.reset}`);
  console.log('');

  await sleep(1500);

  console.log(`${c.white}${c.bold}  Agents need governance, not smarter prompts.${c.reset}`);
  console.log('');

  await sleep(1000);

  console.log(`${c.dim}${hardBreak()}${c.reset}`);
  console.log('');
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const mode = process.argv[2];

  try {
    if (mode === 'unsafe') {
      await showColdOpen();
      await runUnsafeDemo();
    } else if (mode === 'safe') {
      await runSafeDemo();
      await showClosing();
    } else {
      // Run full sequence for recording
      await showColdOpen();
      await runUnsafeDemo();
      await runSafeDemo();
      await showClosing();
    }

    cleanup();
    process.exit(0);
  } catch (err) {
    console.error(`${c.red}Demo failed:${c.reset}`, err);
    cleanup();
    process.exit(1);
  }
}

main();
