import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
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
});
