#!/usr/bin/env node
import { existsSync, realpathSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyReceipts } from './audit.js';
import { cloudConfigPath, readCloudConfig, removeCloudConfig, writeCloudConfig } from './config.js';
import {
  applyClientPatches,
  defaultClientPath,
  isClaudeFailClosed,
  openClawCoverage,
  planClientPatch,
  readClientJson,
  revertLastClientPatches,
  type ClientName,
} from './patches.js';

export const VERSION = '0.7.0';

type FlagMap = Record<string, string | boolean>;
type Check = { name: string; ok: boolean; detail: string; severity?: 'warning' | 'error' };

function parseFlags(args: string[]): FlagMap {
  const flags: FlagMap = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith('--')) continue;
    const [rawKey, inline] = arg.slice(2).split('=', 2);
    if (inline !== undefined) flags[rawKey] = inline;
    else if (args[index + 1] && !args[index + 1].startsWith('--')) flags[rawKey] = args[++index];
    else flags[rawKey] = true;
  }
  return flags;
}

function clientList(value: string | boolean | undefined): ClientName[] {
  const chosen = typeof value === 'string' ? value : 'claude-code';
  if (chosen === 'all') return ['claude-code', 'openclaw', 'mcp'];
  if (chosen === 'claude-code' || chosen === 'openclaw' || chosen === 'mcp') return [chosen];
  throw new Error('--client must be claude-code, openclaw, mcp, or all');
}

async function initCommand(flags: FlagMap): Promise<void> {
  if (flags.revert) {
    const restored = revertLastClientPatches();
    console.log(
      `Restored ${restored.changes.length} configuration file(s) to their previous state.`
    );
    return;
  }

  const clients = clientList(flags.client);
  const explicitPath = typeof flags.config === 'string' ? resolve(flags.config) : undefined;
  if (explicitPath && clients.length !== 1)
    throw new Error('--config requires exactly one --client');
  const patches = clients.map((client) =>
    planClientPatch(client, explicitPath ?? defaultClientPath(client))
  );

  console.log(
    flags.apply ? 'Applying Gatekeeper configuration:' : 'Gatekeeper configuration preview:'
  );
  for (const patch of patches) {
    console.log(`\n${patch.client}: ${patch.path}`);
    console.log(JSON.stringify(patch.after, null, 2));
  }
  if (!flags.apply) {
    console.log(
      '\nNo files changed. Re-run with --apply to create backups and write these changes.'
    );
    return;
  }
  const record = applyClientPatches(patches);
  console.log(
    `\nApplied ${record.changes.length} patch(es). Run \`gatekeeper init --revert\` to restore.`
  );
}

async function connectCommand(flags: FlagMap): Promise<void> {
  const apiUrl = String(flags.api || 'https://api.gatekeeper.runestonelabs.io').replace(/\/$/, '');
  const response = await fetch(`${apiUrl}/v1/device-codes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      instanceName: String(flags.name || hostname()),
      cliVersion: VERSION,
    }),
  });
  if (!response.ok) throw new Error(`Device authorization could not start (${response.status})`);
  const device = (await response.json()) as {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    expiresAt: string;
    interval?: number;
  };
  console.log(`Authorize Gatekeeper at ${device.verificationUri}`);
  console.log(`Code: ${device.userCode}`);
  if (!flags['no-open']) openBrowser(device.verificationUri);

  const intervalMs = Math.max(1000, (device.interval ?? 3) * 1000);
  while (Date.now() < new Date(device.expiresAt).getTime()) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const poll = await fetch(
      `${apiUrl}/v1/device-codes/${encodeURIComponent(device.deviceCode)}/token`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }
    );
    if (poll.status === 202 || poll.status === 204) continue;
    if (poll.status === 410) throw new Error('Device authorization expired');
    if (!poll.ok) throw new Error(`Device authorization failed (${poll.status})`);
    const token = (await poll.json()) as { instanceId: string; instanceToken: string };
    writeCloudConfig({
      apiUrl,
      instanceId: token.instanceId,
      instanceToken: token.instanceToken,
      connectedAt: new Date().toISOString(),
    });
    console.log(
      `Connected instance ${token.instanceId}. Scoped token saved to ${cloudConfigPath()} (0600).`
    );
    console.log('Run `gatekeeper doctor` before treating this installation as protected.');
    return;
  }
  throw new Error('Device authorization expired');
}

function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // The printed verification URL is always the fallback.
  }
}

async function doctorCommand(flags: FlagMap): Promise<void> {
  const checks: Check[] = [];
  let diagnosticBudget = {
    configuredRules: 0,
    maxUtilizationPercent: 0,
    exceededRules: 0,
  };
  const baseUrl = String(flags.url || 'http://127.0.0.1:3847').replace(/\/$/, '');
  let health: Record<string, unknown> | null = null;
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
    health = response.ok ? ((await response.json()) as Record<string, unknown>) : null;
    checks.push({
      name: 'daemon',
      ok: !!health,
      detail: health ? `healthy at ${baseUrl}` : `HTTP ${response.status}`,
      severity: 'error',
    });
  } catch {
    checks.push({
      name: 'daemon',
      ok: false,
      detail: `unreachable at ${baseUrl}`,
      severity: 'error',
    });
  }
  checks.push({
    name: 'policy',
    ok: typeof health?.policyHash === 'string',
    detail:
      typeof health?.policyHash === 'string'
        ? `valid ${health.policyHash}`
        : 'no loaded policy hash',
    severity: 'error',
  });

  try {
    const budgetResponse = await fetch(`${baseUrl}/budget`, { signal: AbortSignal.timeout(3000) });
    const budget = budgetResponse.ok
      ? ((await budgetResponse.json()) as {
          rules?: unknown[];
          statuses?: Array<{
            rule?: { max_usd?: number; max_tokens?: number; max_calls?: number };
            status?: {
              currentUsd?: number;
              currentTokens?: number;
              currentCalls?: number;
              exceeded?: boolean;
            } | null;
          }>;
        })
      : {};
    const statusRatios = (budget.statuses ?? []).map(({ rule, status }) => {
      if (!rule || !status) return [];
      return [
        rule.max_usd ? (status.currentUsd ?? 0) / rule.max_usd : 0,
        rule.max_tokens ? (status.currentTokens ?? 0) / rule.max_tokens : 0,
        rule.max_calls ? (status.currentCalls ?? 0) / rule.max_calls : 0,
      ];
    });
    const ratios = statusRatios.flat();
    diagnosticBudget = {
      configuredRules: Array.isArray(budget.rules) ? budget.rules.length : 0,
      maxUtilizationPercent: Math.max(0, Math.min(1000, Math.round(100 * Math.max(0, ...ratios)))),
      exceededRules: statusRatios.filter((values) => values.some((value) => value >= 1)).length,
    };
    checks.push({
      name: 'budgets',
      ok: Array.isArray(budget.rules) && budget.rules.length > 0,
      detail:
        Array.isArray(budget.rules) && budget.rules.length > 0
          ? `${budget.rules.length} configured`
          : 'no run/actor budget configured',
      severity: 'error',
    });
  } catch {
    checks.push({
      name: 'budgets',
      ok: false,
      detail: 'could not inspect budget state',
      severity: 'error',
    });
  }

  const claudePath = String(flags['claude-config'] || defaultClientPath('claude-code'));
  if (existsSync(claudePath)) {
    try {
      const claude = readClientJson(claudePath);
      const hooked = JSON.stringify(claude).includes('gatekeeper-claude-code');
      checks.push({
        name: 'claude-routing',
        ok: hooked,
        detail: hooked
          ? 'Bash, Write, Edit, and WebFetch are routed; Read, Glob, Grep, NotebookEdit, and non-Gatekeeper MCP tools are outside coverage'
          : 'Gatekeeper PreToolUse hook is absent',
        severity: 'error',
      });
      checks.push({
        name: 'claude-fail-closed',
        ok: hooked && isClaudeFailClosed(claude),
        detail:
          hooked && isClaudeFailClosed(claude)
            ? 'configured'
            : 'FAIL: an unavailable daemon can be bypassed; run `gatekeeper init --client claude-code --apply`',
        severity: 'error',
      });
    } catch (error) {
      checks.push({ name: 'claude-config', ok: false, detail: String(error), severity: 'error' });
    }
  } else {
    checks.push({
      name: 'claude-routing',
      ok: false,
      detail: 'Claude Code config not found',
      severity: 'warning',
    });
  }

  const openClawPath = String(flags['openclaw-config'] || defaultClientPath('openclaw'));
  if (existsSync(openClawPath)) {
    const coverage = openClawCoverage(readClientJson(openClawPath));
    checks.push({
      name: 'openclaw-routing',
      ok: coverage.missingNativeDenies.length === 0,
      detail:
        coverage.missingNativeDenies.length === 0
          ? 'native exec/write/bash denied; Gatekeeper wrappers required'
          : `native bypasses remain: ${coverage.missingNativeDenies.join(', ')}`,
      severity: 'error',
    });
  }

  const mcpPath = String(flags['mcp-config'] || defaultClientPath('mcp'));
  if (existsSync(mcpPath)) {
    try {
      const mcp = readClientJson(mcpPath);
      const configured = JSON.stringify(mcp).includes('@runestone-labs/gatekeeper-mcp');
      checks.push({
        name: 'mcp-routing',
        ok: configured,
        detail: configured
          ? 'Gatekeeper MCP tools fail closed; native host tools and other MCP servers remain outside coverage'
          : 'Gatekeeper MCP server is absent',
        severity: 'error',
      });
    } catch (error) {
      checks.push({ name: 'mcp-config', ok: false, detail: String(error), severity: 'error' });
    }
  }

  const auditDir = resolve(String(flags['audit-dir'] || join(process.cwd(), 'data', 'audit')));
  const verified = verifyReceipts(auditDir);
  checks.push({
    name: 'audit-integrity',
    ok: verified.valid,
    detail: verified.valid
      ? `${verified.chainedEntries} chained receipt(s), ${verified.legacyEntries} legacy receipt(s)`
      : verified.errors[0],
    severity: 'error',
  });

  const cloud = readCloudConfig();
  if (cloud) {
    const permissions = statSync(cloudConfigPath()).mode & 0o077;
    checks.push({
      name: 'instance-token-permissions',
      ok: permissions === 0,
      detail:
        permissions === 0
          ? '0600 or stricter'
          : `group/other permission bits are ${permissions.toString(8)}`,
      severity: 'error',
    });
    try {
      const response = await fetch(`${cloud.apiUrl}/v1/health`, {
        headers: { authorization: `Bearer ${cloud.instanceToken}` },
        signal: AbortSignal.timeout(5000),
      });
      const cloudHealth = response.ok
        ? ((await response.json()) as { approvalDeliveryConfigured?: boolean })
        : null;
      const deliveryConfigured = cloudHealth?.approvalDeliveryConfigured === true;
      checks.push({
        name: 'cloud-and-approval-delivery',
        ok: response.ok && deliveryConfigured,
        detail: !response.ok
          ? `HTTP ${response.status}`
          : deliveryConfigured
            ? `instance ${cloud.instanceId} authenticated; approver email configured`
            : 'instance authenticated, but no verified approver email is available; configure Clerk email claims',
        severity: 'error',
      });
    } catch {
      checks.push({
        name: 'cloud-and-approval-delivery',
        ok: false,
        detail: 'Cloud unreachable',
        severity: 'error',
      });
    }
  } else {
    checks.push({
      name: 'cloud',
      ok: false,
      detail: 'not connected (local OSS remains active)',
      severity: 'warning',
    });
  }

  const protectedInstall = checks.every((check) => check.ok || check.severity === 'warning');
  if (cloud) {
    try {
      await fetch(`${cloud.apiUrl}/v1/diagnostics`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${cloud.instanceToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          schemaVersion: 'gatekeeper-doctor.v1',
          passed: protectedInstall,
          checks: checks.filter((check) => check.ok).map((check) => check.name),
          budgetStatus: diagnosticBudget,
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // The visible Cloud connectivity check already reports this failure.
    }
  }

  if (flags.json) console.log(JSON.stringify({ checks, protected: protectedInstall }, null, 2));
  else {
    for (const check of checks)
      console.log(
        `${check.ok ? 'PASS' : check.severity === 'warning' ? 'WARN' : 'FAIL'}  ${check.name}: ${check.detail}`
      );
  }
  if (checks.some((check) => !check.ok && check.severity === 'error')) process.exitCode = 1;
}

async function verifyCommand(flags: FlagMap, args: string[]): Promise<void> {
  const target = resolve(
    String(
      flags['audit-dir'] ||
        args.find((arg) => !arg.startsWith('--')) ||
        join(process.cwd(), 'data', 'audit')
    )
  );
  const verification = verifyReceipts(target);
  console.log(JSON.stringify({ path: target, ...verification }, null, 2));
  if (!verification.valid) process.exitCode = 1;
}

async function disconnectCommand(flags: FlagMap): Promise<void> {
  const cloud = readCloudConfig();
  if (!cloud) {
    console.log('Gatekeeper Cloud is not connected. Local enforcement is unchanged.');
    return;
  }
  if (!flags['local-only']) {
    const response = await fetch(
      `${cloud.apiUrl}/v1/instances/${encodeURIComponent(cloud.instanceId)}/revoke`,
      { method: 'POST', headers: { authorization: `Bearer ${cloud.instanceToken}` } }
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(
        `Cloud token revocation failed (${response.status}); local credentials were retained`
      );
    }
  }
  removeCloudConfig();
  console.log(
    flags['local-only']
      ? 'Local Cloud configuration removed without remote revocation. Local OSS enforcement remains enabled.'
      : 'Cloud instance token revoked and local Cloud configuration removed. Local OSS enforcement remains enabled.'
  );
}

function usage(): void {
  console.log(`Runestone Gatekeeper ${VERSION}

Usage:
  gatekeeper init [--client claude-code|openclaw|mcp|all] [--config PATH] [--apply]
  gatekeeper init --revert
  gatekeeper connect [--api URL] [--name NAME] [--no-open]
  gatekeeper doctor [--url URL] [--audit-dir PATH] [--json]
  gatekeeper verify [PATH]
  gatekeeper disconnect [--local-only]

init previews every configuration change. --apply writes mode-0600 files after
creating timestamped backups. Cloud credentials never disable local enforcement.`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);
  if (command === '--version' || command === '-v') return console.log(VERSION);
  if (!command || command === 'help' || command === '--help' || command === '-h' || flags.help)
    return usage();
  if (command === 'init') return initCommand(flags);
  if (command === 'connect') return connectCommand(flags);
  if (command === 'doctor') return doctorCommand(flags);
  if (command === 'verify') return verifyCommand(flags, rest);
  if (command === 'disconnect') return disconnectCommand(flags);
  throw new Error(`Unknown command: ${command}`);
}

export function isMainModule(metaUrl: string, argvPath = process.argv[1]): boolean {
  if (!argvPath) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argvPath);
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
