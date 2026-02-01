import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DATA_DIR = '/tmp/gatekeeper-demo-integration-test';

// Set up environment for demo
process.env.GATEKEEPER_SECRET = 'test-secret-key-at-least-32-characters-long';
process.env.DATA_DIR = TEST_DATA_DIR;

// Skip demo integration tests in CI - they require the full environment
// Run manually with: npm run demo
describe.skip('demo script integration', () => {
  beforeAll(() => {
    // Clean up any existing test data
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true });
    }
    mkdirSync(join(TEST_DATA_DIR, 'approvals'), { recursive: true });
    mkdirSync(join(TEST_DATA_DIR, 'audit'), { recursive: true });
  });

  afterAll(() => {
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true });
    }
  });

  it('demo script runs successfully and exits with code 0', async () => {
    const result = await runDemoScript();

    expect(result.exitCode).toBe(0);
  }, 60000); // 60 second timeout

  it('demo output contains DENY marker', async () => {
    const result = await runDemoScript();

    expect(result.stdout).toMatch(/DENY.*shell\.exec/);
  }, 60000);

  it('demo output contains APPROVAL REQUIRED marker', async () => {
    const result = await runDemoScript();

    expect(result.stdout).toMatch(/APPROVAL REQUIRED.*shell\.exec/);
  }, 60000);

  it('demo output contains APPROVED marker', async () => {
    const result = await runDemoScript();

    expect(result.stdout).toMatch(/APPROVED.*shell\.exec/);
  }, 60000);

  it('demo output contains ALLOW marker', async () => {
    const result = await runDemoScript();

    expect(result.stdout).toMatch(/ALLOW.*http\.request/);
  }, 60000);

  it('demo creates audit log entries', async () => {
    await runDemoScript();

    const auditDir = join(TEST_DATA_DIR, 'audit');
    const files = existsSync(auditDir) ? readdirSync(auditDir) : [];
    const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));

    expect(jsonlFiles.length).toBeGreaterThan(0);

    // Read the latest audit file and verify entries
    const latestFile = jsonlFiles.sort().pop()!;
    const content = readFileSync(join(auditDir, latestFile), 'utf-8');
    const lines = content.trim().split('\n').filter(l => l.length > 0);

    // Should have at least 3 entries (deny, approve flow, allow)
    expect(lines.length).toBeGreaterThanOrEqual(3);

    // Verify at least one deny entry
    const hasDeny = lines.some(line => {
      const entry = JSON.parse(line);
      return entry.decision === 'deny';
    });
    expect(hasDeny).toBe(true);
  }, 60000);
});

// Helper to run the demo script
async function runDemoScript(): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', 'scripts/demo.ts'], {
      env: {
        ...process.env,
        GATEKEEPER_SECRET: 'test-secret-key-at-least-32-characters-long',
        DATA_DIR: TEST_DATA_DIR,
        // Force color output for pattern matching
        FORCE_COLOR: '0',
      },
      cwd: process.cwd(),
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });

    child.on('error', (err) => {
      resolve({
        exitCode: 1,
        stdout,
        stderr: stderr + err.message,
      });
    });

    // Timeout safety
    setTimeout(() => {
      child.kill('SIGTERM');
    }, 55000);
  });
}
