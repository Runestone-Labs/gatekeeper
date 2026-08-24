import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isMainModule, main, VERSION } from '../src/index.js';
import { verifyReceipts } from '../src/audit.js';
import {
  applyClientPatches,
  isClaudeFailClosed,
  planClientPatch,
  readClientJson,
  revertLastClientPatches,
} from '../src/patches.js';

const originalConfig = process.env.GATEKEEPER_CONFIG_DIR;
afterEach(() => {
  vi.restoreAllMocks();
  if (originalConfig === undefined) delete process.env.GATEKEEPER_CONFIG_DIR;
  else process.env.GATEKEEPER_CONFIG_DIR = originalConfig;
});

describe('Gatekeeper CLI onboarding', () => {
  it('keeps the CLI version aligned with its package and exposes standard flags', async () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf-8')
    ) as { version: string };
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(VERSION).toBe(packageJson.version);
    await main(['--version']);
    expect(log).toHaveBeenLastCalledWith(packageJson.version);

    await main(['--help']);
    expect(log.mock.calls.at(-1)?.[0]).toContain('Usage:');
  });

  it('recognizes an npm bin symlink as the executable entrypoint', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gatekeeper-cli-bin-'));
    const target = join(directory, 'index.js');
    const bin = join(directory, 'gatekeeper');
    writeFileSync(target, '#!/usr/bin/env node\n');
    symlinkSync(target, bin);

    expect(isMainModule(pathToFileURL(target).href, bin)).toBe(true);
  });

  it('previews fail-closed Claude Code configuration and can restore a timestamped backup', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gatekeeper-cli-'));
    process.env.GATEKEEPER_CONFIG_DIR = join(directory, 'managed');
    const settings = join(directory, 'settings.json');
    writeFileSync(settings, JSON.stringify({ existing: true }));
    const patch = planClientPatch('claude-code', settings);
    expect(isClaudeFailClosed(patch.after)).toBe(true);
    expect(readFileSync(settings, 'utf-8')).toContain('existing');

    const record = applyClientPatches([patch]);
    expect(record.changes[0].backup).toBeTruthy();
    expect(existsSync(record.changes[0].backup!)).toBe(true);
    expect(isClaudeFailClosed(readClientJson(settings))).toBe(true);

    revertLastClientPatches();
    expect(readClientJson(settings)).toEqual({ existing: true });
  });

  it('reverts a newly created config without requiring a backup file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gatekeeper-cli-new-config-'));
    process.env.GATEKEEPER_CONFIG_DIR = join(directory, 'managed');
    const settings = join(directory, 'settings.json');

    applyClientPatches([planClientPatch('claude-code', settings)]);
    expect(existsSync(settings)).toBe(true);

    revertLastClientPatches();
    expect(existsSync(settings)).toBe(false);
  });

  it('refuses to overwrite config changes made after setup', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gatekeeper-cli-edited-config-'));
    process.env.GATEKEEPER_CONFIG_DIR = join(directory, 'managed');
    const settings = join(directory, 'settings.json');
    writeFileSync(settings, JSON.stringify({ existing: true }));

    applyClientPatches([planClientPatch('claude-code', settings)]);
    writeFileSync(settings, JSON.stringify({ changedAfterSetup: true }));

    expect(() => revertLastClientPatches()).toThrow('changed after Gatekeeper setup');
    expect(readClientJson(settings)).toEqual({ changedAfterSetup: true });
  });

  it('reports invalid exported receipt chains', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gatekeeper-cli-audit-'));
    writeFileSync(
      join(directory, '2026-08-23.jsonl'),
      `${JSON.stringify({ sequence: 1, previousEntryHash: null, entryHash: `sha256:${'0'.repeat(64)}` })}\n`
    );
    expect(verifyReceipts(directory).valid).toBe(false);
  });
});
