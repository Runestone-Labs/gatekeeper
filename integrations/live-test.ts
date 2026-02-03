#!/usr/bin/env npx tsx
/**
 * Live Integration Test for Gatekeeper TypeScript Client
 *
 * Run with: GATEKEEPER_URL=http://localhost:3847 npx tsx integrations/live-test.ts
 *
 * Prerequisites:
 * - Gatekeeper running (docker-compose up)
 */

import { GatekeeperClient } from './typescript-client/index.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const GATEKEEPER_URL = process.env.GATEKEEPER_URL || 'http://localhost:3847';

interface TestCase {
  name: string;
  run: () => Promise<{ decision: string; details?: string; valid?: boolean }>;
  expected: 'allow' | 'deny' | 'approve';
  // Optional custom validator - if provided, used instead of decision matching
  validate?: (result: { decision: string; details?: string; valid?: boolean }) => boolean;
}

async function main() {
  console.log('='.repeat(60));
  console.log('Gatekeeper Live Integration Test');
  console.log('='.repeat(60));
  console.log(`Target: ${GATEKEEPER_URL}`);
  console.log('');

  const client = new GatekeeperClient({
    baseUrl: GATEKEEPER_URL,
    agentName: 'live-test',
    runId: `test-${Date.now()}`,
  });

  // Check health first
  console.log('Checking Gatekeeper health...');
  try {
    const health = await client.health();
    console.log(`  Version: ${health.version}`);
    console.log(`  Demo Mode: ${health.demoMode}`);
    console.log(`  Policy Hash: ${health.policyHash.slice(0, 20)}...`);
    console.log('');
  } catch (err) {
    console.error('ERROR: Gatekeeper is not running or unreachable');
    console.error(`  URL: ${GATEKEEPER_URL}`);
    console.error(`  Error: ${err}`);
    process.exit(1);
  }

  // Define test cases
  // Note: The demo policy uses 'approve' for shell.exec and files.write by default
  const tests: TestCase[] = [
    {
      name: 'shell.exec - safe command (ls) [policy: approve]',
      expected: 'approve', // Demo policy requires approval for all shell commands
      run: async () => {
        const result = await client.shellExec({ command: 'ls -la /tmp' });
        return {
          decision: result.decision,
          details: result.decision === 'approve'
            ? `approvalId=${result.approvalId?.slice(0, 8)}...`
            : result.decision === 'allow'
              ? `exit=${result.result?.exitCode}`
              : result.reason,
        };
      },
    },
    {
      name: 'shell.exec - dangerous command (rm -rf) [policy: deny]',
      expected: 'deny',
      run: async () => {
        const result = await client.shellExec({ command: 'rm -rf /' });
        return {
          decision: result.decision,
          details: result.reason,
        };
      },
    },
    {
      name: 'http.request - external API (httpbin) [policy: allow]',
      expected: 'allow',
      run: async () => {
        const result = await client.httpRequest({
          url: 'https://httpbin.org/get',
          method: 'GET',
        });
        return {
          decision: result.decision,
          details:
            result.decision === 'allow'
              ? `status=${result.result?.status}`
              : result.reason,
        };
      },
    },
    {
      name: 'http.request - SSRF attempt (localhost) [policy: blocked at execution]',
      expected: 'allow', // Policy allows http.request, but SSRF protection blocks at execution time
      validate: (result) => {
        // SSRF should be blocked - check for error message indicating private IP blocked
        return result.valid === true;
      },
      run: async () => {
        // Use localhost IP directly to test SSRF protection
        // Note: SSRF is caught at execution time, so decision will be 'allow' but with an error
        const result = await client.httpRequest({
          url: 'http://127.0.0.1:8080/test',
          method: 'GET',
        });

        // SSRF blocking should result in: decision=allow (policy passed), but error set
        const ssrfBlocked = result.error?.includes('private') || result.error?.includes('blocked');

        return {
          decision: result.decision,
          valid: ssrfBlocked, // Test passes if SSRF was blocked
          details: ssrfBlocked
            ? `SSRF blocked: ${result.error}`
            : result.error
              ? `error: ${result.error}`
              : `status=${result.result?.status} (SSRF NOT blocked!)`,
        };
      },
    },
    {
      name: 'files.write - safe path (/tmp) [policy: approve]',
      expected: 'approve', // Demo policy requires approval for file writes
      run: async () => {
        const result = await client.filesWrite({
          path: '/tmp/gatekeeper-test.txt',
          content: 'Hello from Gatekeeper live test!',
        });
        return {
          decision: result.decision,
          details: result.decision === 'approve'
            ? `approvalId=${result.approvalId?.slice(0, 8)}...`
            : result.decision === 'allow'
              ? `bytes=${result.result?.bytesWritten}`
              : result.reason,
        };
      },
    },
    {
      name: 'files.write - blocked extension (.env) [policy: deny]',
      expected: 'deny',
      run: async () => {
        const result = await client.filesWrite({
          path: '/tmp/.env',
          content: 'SECRET=should_be_blocked',
        });
        return {
          decision: result.decision,
          details: result.reason,
        };
      },
    },
  ];

  // Run tests
  console.log('Running test cases...');
  console.log('-'.repeat(60));

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      const result = await test.run();
      // Use custom validator if provided, otherwise compare decision
      const success = test.validate ? test.validate(result) : result.decision === test.expected;

      if (success) {
        passed++;
        console.log(`PASS  ${test.name}`);
        console.log(`      Decision: ${result.decision} (expected: ${test.expected})`);
      } else {
        failed++;
        console.log(`FAIL  ${test.name}`);
        console.log(`      Decision: ${result.decision} (expected: ${test.expected})`);
      }

      if (result.details) {
        console.log(`      Details: ${result.details}`);
      }
      console.log('');
    } catch (err) {
      failed++;
      console.log(`ERROR ${test.name}`);
      console.log(`      ${err}`);
      console.log('');
    }
  }

  // Check audit logs
  console.log('-'.repeat(60));
  console.log('Checking audit logs...');

  const today = new Date().toISOString().split('T')[0];
  const auditPath = join(process.cwd(), 'data', 'audit', `${today}.jsonl`);

  if (existsSync(auditPath)) {
    const content = readFileSync(auditPath, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    const recentEntries = lines.slice(-5);

    console.log(`  Audit file: ${auditPath}`);
    console.log(`  Total entries: ${lines.length}`);
    console.log(`  Recent entries from live-test agent:`);

    for (const line of recentEntries) {
      try {
        const entry = JSON.parse(line);
        if (entry.actor?.name === 'live-test') {
          console.log(`    - ${entry.tool}: ${entry.decision} (${entry.requestId.slice(0, 8)}...)`);
        }
      } catch {
        // Skip malformed lines
      }
    }
  } else {
    console.log(`  Audit file not found: ${auditPath}`);
    console.log('  (This is expected if running against Docker with volume mounts)');
  }

  // Summary
  console.log('');
  console.log('='.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(60));

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
