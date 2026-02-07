import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeFilesWrite } from '../../src/tools/core/filesWrite.js';
import type { ToolPolicy } from '../../src/types.js';

const createdRoots: string[] = [];

function createTempDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'gatekeeper-files-'));
  createdRoots.push(root);
  return root;
}

afterEach(() => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe('executeFilesWrite', () => {
  it('writes within allowed paths', async () => {
    const root = createTempDir();
    const allowedRoot = join(root, 'allowed');
    mkdirSync(allowedRoot, { recursive: true });

    const policy: ToolPolicy = {
      decision: 'allow',
      allowed_paths: [allowedRoot],
    };

    const targetPath = join(allowedRoot, 'note.txt');
    const result = await executeFilesWrite(
      { path: targetPath, content: 'hello', encoding: 'utf8' },
      policy
    );

    expect(result.success).toBe(true);
    expect(readFileSync(targetPath, 'utf8')).toBe('hello');
  });

  it('blocks writes through symlink escape', async () => {
    const root = createTempDir();
    const allowedRoot = join(root, 'allowed');
    const outsideRoot = join(root, 'outside');
    mkdirSync(allowedRoot, { recursive: true });
    mkdirSync(outsideRoot, { recursive: true });

    const linkPath = join(allowedRoot, 'link');
    symlinkSync(outsideRoot, linkPath);

    const policy: ToolPolicy = {
      decision: 'allow',
      allowed_paths: [allowedRoot],
    };

    const targetPath = join(linkPath, 'secret.txt');
    const result = await executeFilesWrite(
      { path: targetPath, content: 'data', encoding: 'utf8' },
      policy
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('resolves outside allowed roots');
  });
});
