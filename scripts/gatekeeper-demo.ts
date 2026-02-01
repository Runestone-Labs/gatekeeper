#!/usr/bin/env tsx
/**
 * Wow Demo: Before/After Contrast
 *
 * Shows the same agent request producing two radically different outcomes:
 * - Ungoverned: Quietly exfiltrates secrets
 * - Governed: Blocked, explained, logged
 *
 * Usage:
 *   npm run wow:unsafe  — Direct fetch, no gatekeeper (scary)
 *   npm run wow:safe    — Same request through gatekeeper (relief)
 *   npm run wow         — Both in sequence
 */

import { spawn, ChildProcess } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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
// UNSAFE MODE: Direct fetch, no gatekeeper
// ═══════════════════════════════════════════════════════════════════════════

async function runUnsafeDemo(): Promise<void> {
  console.log('');
  console.log(`${c.dim}This demo uses a simulated agent.${c.reset}`);
  console.log(`${c.dim}The tools and permissions are real.${c.reset}`);
  console.log('');

  await sleep(1000);

  console.log(`${c.yellow}${c.bold}⚠️  UNGOVERNED AGENT${c.reset}`);
  console.log(`${c.dim}${'─'.repeat(50)}${c.reset}`);
  console.log('');

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

  await sleep(500);

  console.log(`${c.red}💀 Secrets exfiltrated. No crash. No warning. No alert.${c.reset}`);
  console.log('');

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
  console.log('');
  console.log(`${c.green}${c.bold}🛡️  GOVERNED AGENT${c.reset}`);
  console.log(`${c.dim}${'─'.repeat(50)}${c.reset}`);
  console.log('');

  console.log(`${c.dim}Same agent. Same task.${c.reset}`);
  console.log('');

  await sleep(500);

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
      actor: { type: 'agent', name: 'demo-agent', runId: 'wow-demo' },
      args: { url: credsUrl, method: 'GET' },
      context: { conversationId: 'wow-demo' },
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
  // SSRF protection returns success: false with error message
  if (response.status === 403 || result.decision === 'deny') {
    console.log(`${c.red}✗${c.reset} ${c.bold}DENY${c.reset} http.request`);
    console.log(`  ${c.dim}reason: ${result.reason || result.error || 'Blocked by policy'}${c.reset}`);
  } else if (result.success === false && result.error) {
    // SSRF protection blocked the request during execution
    console.log(`${c.red}✗${c.reset} ${c.bold}BLOCKED${c.reset} http.request`);
    console.log(`  ${c.dim}reason: ${result.error}${c.reset}`);
  } else if (result.success === true) {
    // Request went through - shouldn't happen with SSRF protection
    console.log(`${c.green}✓${c.reset} ${c.bold}ALLOWED${c.reset} http.request`);
    console.log(`  ${c.dim}(request succeeded - check SSRF protection)${c.reset}`);
  } else {
    console.log(`${c.yellow}○${c.reset} ${c.bold}${(result.decision || 'PROCESSED').toUpperCase()}${c.reset} http.request`);
    if (result.reason) console.log(`  ${c.dim}reason: ${result.reason}${c.reset}`);
    if (result.error) console.log(`  ${c.dim}error: ${result.error}${c.reset}`);
  }
  console.log('');

  await sleep(500);

  console.log(`${c.cyan}📋 Logged to audit trail${c.reset}`);
  console.log(`${c.cyan}👤 Operator notified${c.reset}`);
  console.log('');

  await sleep(500);

  console.log(`${c.bold}Nothing about the agent changed.${c.reset}`);
  console.log(`${c.bold}The boundary did.${c.reset}`);
  console.log('');

  cleanup();
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const mode = process.argv[2];

  try {
    if (mode === 'unsafe') {
      await runUnsafeDemo();
    } else if (mode === 'safe') {
      await runSafeDemo();
    } else {
      // Run both in sequence
      await runUnsafeDemo();
      await sleep(1000);
      await runSafeDemo();
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
