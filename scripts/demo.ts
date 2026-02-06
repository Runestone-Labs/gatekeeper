#!/usr/bin/env tsx
/**
 * Runestone Gatekeeper Demo Script
 *
 * Demonstrates all three decision types in a single run:
 * 1. DENY - Dangerous shell command blocked
 * 2. APPROVE - Shell command requires approval, then programmatically approved
 * 3. ALLOW - HTTP request allowed immediately
 *
 * Usage: npm run demo
 */

import { spawn, ChildProcess } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Configuration
const BASE_URL = 'http://127.0.0.1:3847';
const DEMO_SECRET = 'demo-secret-at-least-32-characters-long';
const STARTUP_TIMEOUT_MS = 10000;
const SCENARIO_DELAY_MS = 300;

// Fixed UUIDs for deterministic output
const REQUEST_IDS = {
  deny: '00000000-0000-0000-0000-000000000001',
  approve: '00000000-0000-0000-0000-000000000002',
  allow: '00000000-0000-0000-0000-000000000003',
};

// ANSI colors for terminal output
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

// Utility functions
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function log(message: string) {
  console.log(message);
}

function logSection(title: string) {
  log(`\n${colors.bold}${title}${colors.reset}`);
}

function logSuccess(tool: string, details: string) {
  log(`${colors.green}✓${colors.reset} ${colors.bold}ALLOW${colors.reset} ${tool}`);
  log(`  ${colors.dim}${details}${colors.reset}`);
}

function logDeny(tool: string, reason: string) {
  log(`${colors.red}✗${colors.reset} ${colors.bold}DENY${colors.reset} ${tool}`);
  log(`  ${colors.dim}reason: ${reason}${colors.reset}`);
}

function logApprovalRequired(tool: string, id: string) {
  log(`${colors.yellow}○${colors.reset} ${colors.bold}APPROVAL REQUIRED${colors.reset} ${tool}`);
  log(`  ${colors.dim}id: ${id}${colors.reset}`);
}

function logApproved(tool: string, details: string) {
  log(`${colors.green}✓${colors.reset} ${colors.bold}APPROVED${colors.reset} ${tool}`);
  log(`  ${colors.dim}${details}${colors.reset}`);
}

// Server management
let serverProcess: ChildProcess | null = null;

function cleanup() {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
}

function spawnServer(): ChildProcess {
  const env = {
    ...process.env,
    DEMO_MODE: 'true',
    POLICY_PATH: './policy.demo.yaml',
    GATEKEEPER_PORT: '3847',
    BASE_URL: 'http://127.0.0.1:3847',
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

  // Capture but don't display server output (keep demo clean)
  server.stdout?.on('data', () => {});
  server.stderr?.on('data', () => {});

  server.on('error', (err) => {
    console.error('Server process error:', err);
  });

  return server;
}

async function waitForHealth(timeoutMs: number): Promise<void> {
  const startTime = Date.now();
  const pollInterval = 200;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(`${BASE_URL}/health`);
      if (response.ok) {
        const health = await response.json();
        if (health.demoMode === true) {
          return;
        }
      }
    } catch {
      // Server not ready yet
    }
    await sleep(pollInterval);
  }

  throw new Error(`Server did not become ready within ${timeoutMs}ms`);
}

// API helpers
async function postTool(
  toolName: string,
  args: Record<string, unknown>,
  requestId: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${BASE_URL}/tool/${toolName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requestId,
      actor: { type: 'agent', name: 'demo-agent', role: 'openclaw', runId: 'demo-run' },
      args,
      context: { conversationId: 'demo', traceId: requestId },
    }),
  });

  const body = await response.json();
  return { status: response.status, body };
}

async function approveRequest(approveUrl: string): Promise<Record<string, unknown>> {
  const response = await fetch(approveUrl);
  return response.json();
}

// Scenarios
async function runDenyScenario(): Promise<void> {
  const { status, body } = await postTool(
    'shell.exec',
    { command: 'rm -rf /' },
    REQUEST_IDS.deny
  );

  if (status !== 403 || body.decision !== 'deny') {
    throw new Error(`Expected DENY, got status=${status} decision=${body.decision}`);
  }

  logDeny('shell.exec', (body.humanExplanation as string) || 'Denied by policy');
}

async function runApproveScenario(): Promise<void> {
  // Step 1: Request approval
  const { status, body } = await postTool(
    'shell.exec',
    { command: 'ls -la /tmp' },
    REQUEST_IDS.approve
  );

  if (status !== 202 || body.decision !== 'approve') {
    throw new Error(`Expected APPROVE, got status=${status} decision=${body.decision}`);
  }

  const approvalId = body.approvalId as string;
  const approveUrl = body.approveUrl as string;

  if (!approveUrl) {
    throw new Error('DEMO_MODE should include approveUrl in response');
  }

  logApprovalRequired('shell.exec', approvalId);

  await sleep(SCENARIO_DELAY_MS);

  // Step 2: Approve the request
  const approvalResult = await approveRequest(approveUrl);

  if (!approvalResult.success) {
    throw new Error(`Approval failed: ${approvalResult.error}`);
  }

  const output = approvalResult.result as { stdout?: string; exitCode?: number } | undefined;
  const exitCode = output?.exitCode ?? 0;
  const stdout = output?.stdout?.slice(0, 80) || '(no output)';

  logApproved('shell.exec', `exitCode=${exitCode} output="${stdout}..."`);
}

async function runAllowScenario(): Promise<void> {
  const { status, body } = await postTool(
    'http.request',
    { url: 'https://httpbin.org/get', method: 'GET' },
    REQUEST_IDS.allow
  );

  if (status !== 200 || body.decision !== 'allow') {
    throw new Error(`Expected ALLOW, got status=${status} decision=${body.decision}`);
  }

  const result = body.result as { status?: number } | undefined;
  const httpStatus = result?.status ?? 200;

  logSuccess('http.request', `status=${httpStatus}`);
}

// Audit log display
function printAuditLog(): void {
  const today = new Date().toISOString().split('T')[0];
  const auditPath = join(process.cwd(), 'data', 'audit', `${today}.jsonl`);

  logSection('Audit Log');
  log(`${colors.dim}${auditPath}${colors.reset}`);

  if (!existsSync(auditPath)) {
    log(`${colors.dim}(no audit log for today)${colors.reset}`);
    return;
  }

  const content = readFileSync(auditPath, 'utf-8');
  const lines = content.trim().split('\n');
  const lastLines = lines.slice(-3);

  log('');
  log(`${colors.dim}┌${'─'.repeat(78)}┐${colors.reset}`);
  for (const line of lastLines) {
    try {
      const entry = JSON.parse(line);
      const summary = `tool=${entry.tool} decision=${entry.decision}`;
      const truncated = summary.slice(0, 74);
      log(`${colors.dim}│${colors.reset} ${truncated.padEnd(76)} ${colors.dim}│${colors.reset}`);
    } catch {
      const truncated = line.slice(0, 74);
      log(`${colors.dim}│${colors.reset} ${truncated.padEnd(76)} ${colors.dim}│${colors.reset}`);
    }
  }
  log(`${colors.dim}└${'─'.repeat(78)}┘${colors.reset}`);
}

// Main
async function main(): Promise<void> {
  // Setup cleanup handlers
  process.on('SIGINT', () => {
    cleanup();
    process.exit(1);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(1);
  });

  try {
    // Header
    log('');
    log(`${colors.bold}${colors.cyan}Runestone Gatekeeper Demo${colors.reset}`);
    log(`${colors.dim}${'═'.repeat(40)}${colors.reset}`);

    // Start server
    log(`\n${colors.dim}Starting server...${colors.reset}`);
    serverProcess = spawnServer();

    // Wait for ready
    await waitForHealth(STARTUP_TIMEOUT_MS);
    log(`${colors.dim}Server ready${colors.reset}`);

    // Run scenarios
    logSection('Scenario 1: Dangerous Command');
    await runDenyScenario();
    await sleep(SCENARIO_DELAY_MS);

    logSection('Scenario 2: Safe Command (Needs Approval)');
    await runApproveScenario();
    await sleep(SCENARIO_DELAY_MS);

    logSection('Scenario 3: HTTP Request');
    await runAllowScenario();
    await sleep(SCENARIO_DELAY_MS);

    // Show audit log
    printAuditLog();

    // Summary
    log('');
    log(`${colors.bold}${colors.green}Demo complete!${colors.reset}`);
    log(`${colors.dim}Agents need seatbelts: deny → approve → allow in one run.${colors.reset}`);
    log('');

    cleanup();
    process.exit(0);
  } catch (err) {
    log('');
    log(`${colors.red}${colors.bold}Demo failed:${colors.reset} ${err}`);
    cleanup();
    process.exit(1);
  }
}

main();
