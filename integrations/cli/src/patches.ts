import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { configDirectory } from './config.js';

export type ClientName = 'claude-code' | 'openclaw' | 'mcp';

export interface PlannedPatch {
  client: ClientName;
  path: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

type PatchRecord = {
  createdAt: string;
  changes: Array<{ path: string; backup: string | null; appliedHash?: string }>;
};

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} does not contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function claudePatch(path: string): PlannedPatch {
  const before = readJson(path);
  const after = structuredClone(before);
  const hooks = objectAt(after, 'hooks');
  const pre = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  const command =
    process.platform === 'win32'
      ? 'set "GATEKEEPER_FAIL_CLOSED=1" && npx -y @runestone-labs/gatekeeper-claude-code'
      : 'GATEKEEPER_FAIL_CLOSED=1 npx -y @runestone-labs/gatekeeper-claude-code';
  const managed = {
    matcher: 'Bash|Write|Edit|WebFetch',
    hooks: [
      {
        type: 'command',
        command,
      },
    ],
  };
  hooks.PreToolUse = [
    ...pre.filter(
      (entry) =>
        !JSON.stringify(entry).includes('@runestone-labs/gatekeeper-claude-code') &&
        !JSON.stringify(entry).includes('gatekeeper-claude-code-hook')
    ),
    managed,
  ];
  return { client: 'claude-code', path, before, after };
}

function openClawPatch(path: string): PlannedPatch {
  const before = readJson(path);
  const after = structuredClone(before);
  const env = objectAt(after, 'env');
  env.GATEKEEPER_URL = 'http://127.0.0.1:3847';
  const tools = objectAt(after, 'tools');
  tools.deny = uniqueStrings([...arrayAt(tools, 'deny'), 'exec', 'write', 'bash']);
  tools.alsoAllow = uniqueStrings([
    ...arrayAt(tools, 'alsoAllow'),
    'gk_exec',
    'gk_write',
    'gk_http',
  ]);
  const plugins = objectAt(after, 'plugins');
  const entries = objectAt(plugins, 'entries');
  entries.gatekeeper = { enabled: true };
  return { client: 'openclaw', path, before, after };
}

function mcpPatch(path: string): PlannedPatch {
  const before = readJson(path);
  const after = structuredClone(before);
  const servers = objectAt(after, 'mcpServers');
  servers.gatekeeper = {
    command: 'npx',
    args: ['-y', '@runestone-labs/gatekeeper-mcp'],
    env: {
      GATEKEEPER_URL: 'http://127.0.0.1:3847',
      GATEKEEPER_ROLE: 'mcp-client',
    },
  };
  return { client: 'mcp', path, before, after };
}

function objectAt(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = parent[key];
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }
  const created: Record<string, unknown> = {};
  parent[key] = created;
  return created;
}

function arrayAt(parent: Record<string, unknown>, key: string): string[] {
  return Array.isArray(parent[key])
    ? (parent[key] as unknown[]).filter((value): value is string => typeof value === 'string')
    : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

export function defaultClientPath(client: ClientName): string {
  if (client === 'claude-code') return join(homedir(), '.claude', 'settings.json');
  if (client === 'openclaw') return join(homedir(), '.openclaw', 'openclaw.json');
  if (process.platform === 'darwin') {
    return join(
      homedir(),
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json'
    );
  }
  return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

export function planClientPatch(
  client: ClientName,
  path = defaultClientPath(client)
): PlannedPatch {
  if (client === 'claude-code') return claudePatch(path);
  if (client === 'openclaw') return openClawPatch(path);
  return mcpPatch(path);
}

export function applyClientPatches(patches: PlannedPatch[]): PatchRecord {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const record: PatchRecord = { createdAt: new Date().toISOString(), changes: [] };
  for (const patch of patches) {
    mkdirSync(dirname(patch.path), { recursive: true, mode: 0o700 });
    let backup: string | null = null;
    if (existsSync(patch.path)) {
      backup = `${patch.path}.gatekeeper-backup-${stamp}`;
      copyFileSync(patch.path, backup);
    }
    const appliedContent = `${JSON.stringify(patch.after, null, 2)}\n`;
    writeFileSync(patch.path, appliedContent, { mode: 0o600 });
    chmodSync(patch.path, 0o600);
    record.changes.push({ path: patch.path, backup, appliedHash: contentHash(appliedContent) });
  }
  mkdirSync(configDirectory(), { recursive: true, mode: 0o700 });
  writeFileSync(join(configDirectory(), 'last-init.json'), JSON.stringify(record, null, 2), {
    mode: 0o600,
  });
  return record;
}

export function revertLastClientPatches(): PatchRecord {
  const manifest = join(configDirectory(), 'last-init.json');
  if (!existsSync(manifest)) throw new Error('No Gatekeeper init manifest was found');
  const record = JSON.parse(readFileSync(manifest, 'utf-8')) as PatchRecord;
  for (const change of record.changes) {
    if (
      change.appliedHash &&
      existsSync(change.path) &&
      contentHash(readFileSync(change.path, 'utf-8')) !== change.appliedHash
    ) {
      throw new Error(`Cannot safely restore ${change.path}; it changed after Gatekeeper setup`);
    }
    if (!change.backup) {
      if (existsSync(change.path)) unlinkSync(change.path);
      continue;
    }
    if (!existsSync(change.backup)) {
      throw new Error(`Cannot safely restore ${change.path}; its backup is unavailable`);
    }
    copyFileSync(change.backup, change.path);
    chmodSync(change.path, 0o600);
  }
  return record;
}

export function isClaudeFailClosed(settings: Record<string, unknown>): boolean {
  const serialized = JSON.stringify(settings);
  return (
    serialized.includes('GATEKEEPER_FAIL_CLOSED=1') ||
    serialized.includes('GATEKEEPER_FAIL_CLOSED=true')
  );
}

export function openClawCoverage(settings: Record<string, unknown>): {
  protectedTools: string[];
  missingNativeDenies: string[];
} {
  const tools =
    settings.tools && typeof settings.tools === 'object' && !Array.isArray(settings.tools)
      ? (settings.tools as Record<string, unknown>)
      : {};
  const denied = arrayAt(tools, 'deny');
  const required = ['exec', 'write', 'bash'];
  return {
    protectedTools: required.filter((tool) => denied.includes(tool)),
    missingNativeDenies: required.filter((tool) => !denied.includes(tool)),
  };
}

export function readClientJson(path: string): Record<string, unknown> {
  return readJson(path);
}
