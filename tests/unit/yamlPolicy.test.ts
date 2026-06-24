import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { YamlPolicySource } from '../../src/providers/yaml-policy.js';

describe('YamlPolicySource', () => {
  it('merges base policy and principals file', async () => {
    const policyPath = join(process.cwd(), 'tests/fixtures/policy-main.yaml');
    const source = new YamlPolicySource(policyPath);
    const policy = await source.load();

    expect(policy.tools['shell.exec'].decision).toBe('approve');
    expect(policy.tools['shell.exec'].deny_patterns).toEqual(['rm -rf', 'sudo']);

    expect(policy.global_deny_patterns).toEqual(['token=.+', 'secret=.+']);

    expect(policy.principals?.navigator).toBeDefined();
    expect(policy.principals?.openclaw).toBeDefined();
  });

  // Regression: the runtime provider previously DROPPED budgets + cost_usd, so
  // configuring a budget in policy.yaml silently did nothing (/budget showed
  // "No budgets configured"). Lock the full budget surface here.
  describe('budgets + cost_usd', () => {
    let dir: string;
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it('parses tool cost_usd and budgets incl. per-run scope + token/call ceilings', async () => {
      dir = mkdtempSync(join(tmpdir(), 'gk-policy-'));
      const p = join(dir, 'policy.yaml');
      writeFileSync(
        p,
        [
          'tools:',
          '  http.request:',
          '    decision: allow',
          '    cost_usd: 0.02',
          'budgets:',
          '  - name: per-run-cap',
          '    match:',
          '      actor_role: openclaw',
          '    scope: run',
          '    window: day',
          '    max_usd: 5',
          '    max_tokens: 1000000',
          '    max_calls: 200',
          '    mode: hard',
          '  - name: researcher-daily',
          '    match:',
          '      actor_role: researcher',
          '    window: day',
          '    max_usd: 3',
          '',
        ].join('\n')
      );

      const policy = await new YamlPolicySource(p).load();

      expect(policy.tools['http.request'].cost_usd).toBe(0.02);
      expect(policy.budgets).toHaveLength(2);

      const run = policy.budgets!.find((b) => b.name === 'per-run-cap')!;
      expect(run.scope).toBe('run');
      expect(run.max_usd).toBe(5);
      expect(run.max_tokens).toBe(1_000_000);
      expect(run.max_calls).toBe(200);

      const daily = policy.budgets!.find((b) => b.name === 'researcher-daily')!;
      expect(daily.scope).toBeUndefined(); // defaults to actor scope
      expect(daily.max_tokens).toBeUndefined();
    });
  });
});
