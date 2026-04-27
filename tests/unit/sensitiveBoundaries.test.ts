import { describe, it, expect, beforeEach } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { evaluateTool } from '../../src/policy/evaluate.js';
import {
  evaluateSensitiveBoundaries,
  _clearBoundaryRegexCache,
} from '../../src/policy/sensitiveBoundaries.js';
import { DEFAULT_SENSITIVE_BOUNDARIES } from '../../src/policy/sensitiveBoundaryDefaults.js';
import { loadPolicy, clearPolicyCache } from '../../src/policy/loadPolicy.js';
import { Policy, SensitiveBoundaryRule } from '../../src/types.js';

// A minimal Policy that defaults to allow on shell.exec / files.write so the
// boundary check is what drives any deny/approve decisions in these tests.
const allowAllPolicy: Policy = {
  tools: {
    'shell.exec': { decision: 'allow' },
    'files.write': { decision: 'allow' },
    'http.request': { decision: 'allow' },
  },
};

beforeEach(() => {
  _clearBoundaryRegexCache();
});

describe('sensitive boundary evaluator (unit)', () => {
  it('returns null when no rule matches', () => {
    const result = evaluateSensitiveBoundaries(
      'shell.exec',
      { command: 'echo hello' },
      DEFAULT_SENSITIVE_BOUNDARIES
    );
    expect(result).toBeNull();
  });

  it('returns null for tools the rule pack does not cover', () => {
    const result = evaluateSensitiveBoundaries(
      'http.request',
      { url: 'https://example.com' },
      DEFAULT_SENSITIVE_BOUNDARIES
    );
    expect(result).toBeNull();
  });

  it('picks the highest-risk rule when several would match', () => {
    // Both keychain-read (high) and keychain-secret-dump (critical) match
    // `security find-generic-password -s X -w`. Critical should win.
    const result = evaluateSensitiveBoundaries(
      'shell.exec',
      { command: 'security find-generic-password -s "Foo" -w' },
      DEFAULT_SENSITIVE_BOUNDARIES
    );
    expect(result?.decision).toBe('deny');
    expect(result?.riskFlags).toContain('boundary:keychain-secret-dump');
    expect(result?.risk).toBe('critical');
  });

  it('an explicit allow rule short-circuits and returns null (whitelist)', () => {
    const rules: SensitiveBoundaryRule[] = [
      {
        id: 'allow-test-keychain',
        effect: 'allow',
        tools: ['shell.exec'],
        match: { command_regex: 'find-generic-password -s "TestFixture"' },
        category: 'test',
        resource_class: 'credential_store',
        risk: 'high',
        message: 'whitelist',
      },
      ...DEFAULT_SENSITIVE_BOUNDARIES,
    ];
    const result = evaluateSensitiveBoundaries(
      'shell.exec',
      { command: 'security find-generic-password -s "TestFixture"' },
      rules
    );
    expect(result).toBeNull();
  });

  it('mirrors classification into riskFlags for legacy audit consumers', () => {
    const result = evaluateSensitiveBoundaries(
      'shell.exec',
      { command: 'security find-generic-password -s "Chromium Safe Storage"' },
      DEFAULT_SENSITIVE_BOUNDARIES
    );
    expect(result?.riskFlags).toEqual(
      expect.arrayContaining([
        'boundary:keychain-read',
        'category:credential_store_access',
        'resource:credential_store',
        'risk:high',
      ])
    );
  });
});

describe('default rule pack — per-rule coverage', () => {
  describe('macOS Keychain', () => {
    it('keychain-read: require_approval on `security find-generic-password`', () => {
      const result = evaluateSensitiveBoundaries(
        'shell.exec',
        { command: 'security find-generic-password -s "Chromium Safe Storage"' },
        DEFAULT_SENSITIVE_BOUNDARIES
      );
      expect(result?.decision).toBe('approve');
      expect(result?.category).toBe('credential_store_access');
      expect(result?.risk).toBe('high');
      expect(result?.saferAlternative).toMatch(/throwaway|mock|user-data-dir/i);
    });

    it('keychain-read: matches dump-keychain', () => {
      const result = evaluateSensitiveBoundaries(
        'shell.exec',
        { command: 'security dump-keychain' },
        DEFAULT_SENSITIVE_BOUNDARIES
      );
      expect(result?.decision).toBe('approve');
    });

    it('keychain-secret-dump: deny on -w flag', () => {
      const result = evaluateSensitiveBoundaries(
        'shell.exec',
        { command: 'security find-generic-password -s "Foo" -w' },
        DEFAULT_SENSITIVE_BOUNDARIES
      );
      expect(result?.decision).toBe('deny');
      expect(result?.risk).toBe('critical');
    });

    it('keychain-delete: deny on delete-generic-password', () => {
      const result = evaluateSensitiveBoundaries(
        'shell.exec',
        { command: 'security delete-generic-password -s "Chromium Safe Storage"' },
        DEFAULT_SENSITIVE_BOUNDARIES
      );
      expect(result?.decision).toBe('deny');
      expect(result?.riskFlags).toContain('boundary:keychain-delete');
    });

    it('benign-near-miss: `security` as a word inside a longer phrase does not match', () => {
      const result = evaluateSensitiveBoundaries(
        'shell.exec',
        { command: 'echo "this is about cybersecurity research"' },
        DEFAULT_SENSITIVE_BOUNDARIES
      );
      expect(result).toBeNull();
    });
  });

  describe('SSH keys', () => {
    it('ssh-private-key: deny when shell command reads ~/.ssh/id_ed25519', () => {
      const result = evaluateSensitiveBoundaries(
        'shell.exec',
        { command: 'cat ~/.ssh/id_ed25519' },
        DEFAULT_SENSITIVE_BOUNDARIES
      );
      expect(result?.decision).toBe('deny');
      expect(result?.resourceClass).toBe('private_key');
    });

    it('ssh-private-key: deny when files.write targets a private key', () => {
      const result = evaluateSensitiveBoundaries(
        'files.write',
        { path: '/Users/dev/.ssh/id_rsa', content: '...' },
        DEFAULT_SENSITIVE_BOUNDARIES
      );
      expect(result?.decision).toBe('deny');
    });

    it('ssh-private-key: does NOT fire on .pub public keys (the dir-enumeration rule may still gate)', () => {
      const result = evaluateSensitiveBoundaries(
        'shell.exec',
        { command: 'cat ~/.ssh/id_ed25519.pub' },
        DEFAULT_SENSITIVE_BOUNDARIES
      );
      // Reading a public key is fine for the *private-key* rule; reading from
      // the SSH directory at all is a separate (lower) gate via dir-enumeration.
      if (result) {
        expect(result.riskFlags).not.toContain('boundary:ssh-private-key');
      }
    });

    it('ssh-private-key: pure files.write to a .pub file is NOT denied', () => {
      const result = evaluateSensitiveBoundaries(
        'files.write',
        { path: '/Users/dev/.ssh/id_ed25519.pub', content: 'ssh-ed25519 ...' },
        DEFAULT_SENSITIVE_BOUNDARIES
      );
      expect(result).toBeNull();
    });

    it('ssh-dir-enumeration: require_approval on `ls ~/.ssh`', () => {
      const result = evaluateSensitiveBoundaries(
        'shell.exec',
        { command: 'ls -la ~/.ssh' },
        DEFAULT_SENSITIVE_BOUNDARIES
      );
      expect(result?.decision).toBe('approve');
      expect(result?.riskFlags).toContain('boundary:ssh-dir-enumeration');
    });
  });

  describe('cloud credentials', () => {
    it('aws-credentials: deny on `cat ~/.aws/credentials`', () => {
      const result = evaluateSensitiveBoundaries(
        'shell.exec',
        { command: 'cat ~/.aws/credentials' },
        DEFAULT_SENSITIVE_BOUNDARIES
      );
      expect(result?.decision).toBe('deny');
    });

    it('gcloud-credentials: deny on files.write into ~/.config/gcloud/', () => {
      const result = evaluateSensitiveBoundaries(
        'files.write',
        { path: '/Users/dev/.config/gcloud/application_default_credentials.json', content: '{}' },
        DEFAULT_SENSITIVE_BOUNDARIES
      );
      expect(result?.decision).toBe('deny');
    });

    it('azure-credentials: deny on `cat ~/.azure/credentials`', () => {
      const result = evaluateSensitiveBoundaries(
        'shell.exec',
        { command: 'cat ~/.azure/credentials' },
        DEFAULT_SENSITIVE_BOUNDARIES
      );
      expect(result?.decision).toBe('deny');
    });
  });

  describe('env / package / vcs auth', () => {
    it('dotenv-read: require_approval on `cat .env.local`', () => {
      const result = evaluateSensitiveBoundaries(
        'shell.exec',
        { command: 'cat .env.local' },
        DEFAULT_SENSITIVE_BOUNDARIES
      );
      expect(result?.decision).toBe('approve');
    });

    it('npmrc-token: deny on writing ~/.npmrc', () => {
      const result = evaluateSensitiveBoundaries(
        'files.write',
        { path: '/Users/dev/.npmrc', content: '//registry...' },
        DEFAULT_SENSITIVE_BOUNDARIES
      );
      expect(result?.decision).toBe('deny');
    });

    it('pypirc-token: deny on reading ~/.pypirc via shell', () => {
      const result = evaluateSensitiveBoundaries(
        'shell.exec',
        { command: 'cat ~/.pypirc' },
        DEFAULT_SENSITIVE_BOUNDARIES
      );
      expect(result?.decision).toBe('deny');
    });

    it('git-credentials: deny on reading ~/.git-credentials', () => {
      const result = evaluateSensitiveBoundaries(
        'shell.exec',
        { command: 'cat ~/.git-credentials' },
        DEFAULT_SENSITIVE_BOUNDARIES
      );
      expect(result?.decision).toBe('deny');
    });

    it('gh-cli-token: deny on `gh auth token`', () => {
      const result = evaluateSensitiveBoundaries(
        'shell.exec',
        { command: 'gh auth token' },
        DEFAULT_SENSITIVE_BOUNDARIES
      );
      expect(result?.decision).toBe('deny');
    });
  });

  describe('browser profiles', () => {
    it('browser-profile-chromium: require_approval on Chrome profile read', () => {
      const result = evaluateSensitiveBoundaries(
        'shell.exec',
        {
          command: 'ls "/Users/dev/Library/Application Support/Google/Chrome/Default/Login Data"',
        },
        DEFAULT_SENSITIVE_BOUNDARIES
      );
      expect(result?.decision).toBe('approve');
    });

    it('browser-profile-firefox: require_approval on Firefox profile read', () => {
      const result = evaluateSensitiveBoundaries(
        'shell.exec',
        {
          command: 'ls "/Users/dev/Library/Application Support/Firefox/Profiles/abc123.default"',
        },
        DEFAULT_SENSITIVE_BOUNDARIES
      );
      expect(result?.decision).toBe('approve');
    });

    it('browser-profile-delete: deny on `rm -rf` against a Chrome profile', () => {
      const result = evaluateSensitiveBoundaries(
        'shell.exec',
        {
          command: 'rm -rf "/Users/dev/Library/Application Support/Google/Chrome/Default"',
        },
        DEFAULT_SENSITIVE_BOUNDARIES
      );
      expect(result?.decision).toBe('deny');
      expect(result?.risk).toBe('critical');
    });
  });

  describe('home secret grep', () => {
    it('home-secret-grep: require_approval on broad home-dir secret search', () => {
      const result = evaluateSensitiveBoundaries(
        'shell.exec',
        { command: 'grep -r "api_key" $HOME' },
        DEFAULT_SENSITIVE_BOUNDARIES
      );
      expect(result?.decision).toBe('approve');
    });

    it('home-secret-grep: scoped repo-local search does NOT match', () => {
      const result = evaluateSensitiveBoundaries(
        'shell.exec',
        { command: 'grep -r "api_key" ./src' },
        DEFAULT_SENSITIVE_BOUNDARIES
      );
      expect(result).toBeNull();
    });
  });
});

describe('Puppeteer → Keychain escalation scenario (the demo)', () => {
  it('step 1: editing Puppeteer launch flags in /tmp is allowed', () => {
    const policy: Policy = {
      ...allowAllPolicy,
      tools: {
        ...allowAllPolicy.tools,
        'files.write': { decision: 'allow', allowed_paths: ['/tmp/'] },
      },
    };
    const result = evaluateTool(
      'files.write',
      { path: '/tmp/puppeteer-config.ts', content: '--use-mock-keychain' },
      policy
    );
    expect(result.decision).toBe('allow');
  });

  it('step 2: `security find-generic-password` requires approval', () => {
    const result = evaluateTool(
      'shell.exec',
      { command: 'security find-generic-password -s "Chromium Safe Storage"' },
      allowAllPolicy
    );
    expect(result.decision).toBe('approve');
    expect(result.reasonCode).toBe('BOUNDARY_REQUIRES_APPROVAL');
    expect(result.riskFlags).toContain('boundary:keychain-read');
  });

  it('step 3: `security delete-generic-password` is denied outright', () => {
    const result = evaluateTool(
      'shell.exec',
      { command: 'security delete-generic-password -s "Chromium Safe Storage"' },
      allowAllPolicy
    );
    expect(result.decision).toBe('deny');
    expect(result.reasonCode).toBe('BOUNDARY_DENIED');
    expect(result.riskFlags).toContain('boundary:keychain-delete');
    expect(result.risk).toBe('critical');
  });
});

describe('boundary check ordering inside evaluateTool', () => {
  it('boundary deny short-circuits before tool-level deny_patterns run', () => {
    const policy: Policy = {
      tools: {
        'shell.exec': {
          decision: 'allow',
          // This pattern would also match, but the boundary rule should fire first.
          deny_patterns: ['security '],
        },
      },
    };
    const result = evaluateTool(
      'shell.exec',
      { command: 'security delete-generic-password -s "Foo"' },
      policy
    );
    expect(result.reasonCode).toBe('BOUNDARY_DENIED');
  });

  it('boundary check still runs even when default tool decision is allow', () => {
    const result = evaluateTool('shell.exec', { command: 'cat ~/.ssh/id_rsa' }, allowAllPolicy);
    expect(result.decision).toBe('deny');
    expect(result.riskFlags).toContain('boundary:ssh-private-key');
  });

  it('user-supplied policy.sensitive_boundaries replaces defaults', () => {
    // No boundary rules provided -> the default Keychain rule does NOT fire
    // (because the user opted into an empty pack).
    const policy: Policy = {
      ...allowAllPolicy,
      sensitive_boundaries: [],
    };
    const result = evaluateTool(
      'shell.exec',
      { command: 'security find-generic-password -s "X"' },
      policy
    );
    expect(result.decision).toBe('allow');
  });
});

describe('YAML loading: sensitive_boundaries', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gk-sb-'));
    clearPolicyCache();
    _clearBoundaryRegexCache();
  });

  function writePolicy(yamlBody: string): string {
    const path = join(dir, 'policy.yaml');
    writeFileSync(path, yamlBody);
    return path;
  }

  it('loads defaults when no override is supplied', () => {
    const path = writePolicy(`
tools:
  shell.exec:
    decision: allow
`);
    const policy = loadPolicy(path);
    expect(policy.sensitive_boundaries?.length).toBe(DEFAULT_SENSITIVE_BOUNDARIES.length);
  });

  it('user override with same id replaces the default', () => {
    const path = writePolicy(`
tools:
  shell.exec:
    decision: allow
sensitive_boundaries:
  - id: keychain-read
    effect: allow
    tools: [shell.exec]
    match:
      command_regex: 'security find-generic-password'
    category: dev_whitelist
    resource_class: credential_store
    risk: low
    message: 'Whitelisted in dev'
`);
    const policy = loadPolicy(path);
    const keychainRead = policy.sensitive_boundaries?.find((r) => r.id === 'keychain-read');
    expect(keychainRead?.effect).toBe('allow');
    expect(keychainRead?.category).toBe('dev_whitelist');
  });

  it('new id appends to the rule pack', () => {
    const path = writePolicy(`
tools:
  shell.exec:
    decision: allow
sensitive_boundaries:
  - id: custom-secret-store
    effect: deny
    tools: [shell.exec]
    match:
      command_regex: 'op read'
    category: secret_manager_access
    resource_class: credential_store
    risk: high
    message: 'Reading from 1Password CLI is gated.'
`);
    const policy = loadPolicy(path);
    expect(policy.sensitive_boundaries?.length).toBe(DEFAULT_SENSITIVE_BOUNDARIES.length + 1);
    expect(policy.sensitive_boundaries?.find((r) => r.id === 'custom-secret-store')).toBeDefined();
  });

  it('throws on invalid effect at load time', () => {
    const path = writePolicy(`
tools:
  shell.exec:
    decision: allow
sensitive_boundaries:
  - id: bad
    effect: blocked
    tools: [shell.exec]
    match: { command_regex: '.' }
    category: x
    resource_class: x
    risk: high
    message: x
`);
    expect(() => loadPolicy(path)).toThrow(/invalid effect/);
  });

  it('throws on missing match patterns', () => {
    const path = writePolicy(`
tools:
  shell.exec:
    decision: allow
sensitive_boundaries:
  - id: no-match
    effect: deny
    tools: [shell.exec]
    match: {}
    category: x
    resource_class: x
    risk: high
    message: x
`);
    expect(() => loadPolicy(path)).toThrow(/at least one of match/);
  });

  it('throws on invalid regex at load time (fail-fast)', () => {
    const path = writePolicy(`
tools:
  shell.exec:
    decision: allow
sensitive_boundaries:
  - id: bad-regex
    effect: deny
    tools: [shell.exec]
    match: { command_regex: '[invalid(' }
    category: x
    resource_class: x
    risk: high
    message: x
`);
    expect(() => loadPolicy(path)).toThrow(/invalid regex/);
  });

  it('throws on duplicate id within user overrides', () => {
    const path = writePolicy(`
tools:
  shell.exec:
    decision: allow
sensitive_boundaries:
  - id: dup
    effect: deny
    tools: [shell.exec]
    match: { command_regex: 'a' }
    category: x
    resource_class: x
    risk: high
    message: x
  - id: dup
    effect: deny
    tools: [shell.exec]
    match: { command_regex: 'b' }
    category: x
    resource_class: x
    risk: high
    message: x
`);
    expect(() => loadPolicy(path)).toThrow(/Duplicate sensitive_boundaries id/);
  });
});
