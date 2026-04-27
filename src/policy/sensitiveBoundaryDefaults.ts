import { SensitiveBoundaryRule } from '../types.js';

/**
 * Built-in sensitive-resource boundary rules.
 *
 * These rules guard local resources that coding agents should not touch as a
 * side effect of debugging — Keychain, SSH keys, cloud credentials, browser
 * profiles, package-registry tokens, env files. The rule pack catches the
 * "helpful overreach" failure mode: the agent isn't malicious, it just escalates
 * from a code-level fix into a credential-level operation.
 *
 * YAML overrides in `policy.yaml` under `sensitive_boundaries:` merge by `id`
 * — same-id replaces a default, new ids append. An override with `effect: allow`
 * silences the default for known-safe paths (e.g. a dev fixture).
 *
 * Design notes:
 * - Anchored regexes prefer `^\s*<cmd>` so accidental substring matches don't fire.
 * - `path_regex` uses `(^|/)\.foo` so both absolute and relative paths match.
 * - `.pub` is explicitly excluded from the SSH key rule (public keys are fine).
 * - Risk levels are sorted desc by the evaluator so the strongest rule wins.
 */
export const DEFAULT_SENSITIVE_BOUNDARIES: SensitiveBoundaryRule[] = [
  // ---------- macOS Keychain ----------
  {
    id: 'keychain-secret-dump',
    effect: 'deny',
    tools: ['shell.exec'],
    match: {
      command_regex: '^\\s*security\\b[^\\n]*\\s-w(\\s|$)',
    },
    category: 'credential_exfiltration',
    resource_class: 'credential_store',
    risk: 'critical',
    message: 'The `security -w` flag prints raw Keychain secrets to stdout.',
  },
  {
    id: 'keychain-delete',
    effect: 'deny',
    tools: ['shell.exec'],
    match: {
      command_regex: '^\\s*security\\s+delete-(generic-password|internet-password|certificate)\\b',
    },
    category: 'credential_store_destruction',
    resource_class: 'credential_store',
    risk: 'critical',
    message: 'Deleting Keychain credentials is destructive and outside coding-agent authority.',
  },
  {
    id: 'keychain-read',
    effect: 'require_approval',
    tools: ['shell.exec'],
    match: {
      command_regex:
        '^\\s*security\\s+(find-(generic-password|internet-password|certificate)|dump-keychain)\\b',
    },
    category: 'credential_store_access',
    resource_class: 'credential_store',
    risk: 'high',
    message: 'Inspecting macOS Keychain entries crosses a sensitive local boundary.',
    safer_alternative:
      "Use a throwaway Chromium profile with `--user-data-dir=$(mktemp -d)` and `--use-mock-keychain` instead of inspecting the user's Keychain.",
  },

  // ---------- SSH keys ----------
  {
    id: 'ssh-private-key',
    effect: 'deny',
    tools: ['shell.exec', 'files.write'],
    match: {
      // Match id_rsa, id_ed25519, id_ecdsa, id_dsa, *.pem under ~/.ssh
      // Excludes *.pub via the negative class on the suffix.
      path_regex: '(^|/)\\.ssh/(id_[a-z0-9]+(?!\\.pub)|[^/]+\\.pem)(\\s|$|"|\')',
    },
    category: 'ssh_key_access',
    resource_class: 'private_key',
    risk: 'critical',
    message: 'Reading or writing private SSH keys is forbidden.',
  },
  {
    id: 'ssh-dir-enumeration',
    effect: 'require_approval',
    tools: ['shell.exec'],
    match: {
      command_regex: '\\b(ls|find|grep|cat|tree)\\b[^\\n]*(~|\\$HOME)/\\.ssh\\b',
    },
    category: 'sensitive_directory_enumeration',
    resource_class: 'private_key',
    risk: 'high',
    message: 'Enumerating ~/.ssh exposes private key filenames and metadata.',
    safer_alternative:
      'If you need to know which keys exist, ask the user. Public keys (.pub) can be checked individually.',
  },

  // ---------- Cloud credentials ----------
  {
    id: 'aws-credentials',
    effect: 'deny',
    tools: ['shell.exec', 'files.write'],
    match: {
      path_regex: '(^|/)\\.aws/(credentials|config)(\\s|$|"|\')',
    },
    category: 'cloud_credentials',
    resource_class: 'cloud_credentials',
    risk: 'critical',
    message: 'AWS credentials are off-limits.',
  },
  {
    id: 'gcloud-credentials',
    effect: 'deny',
    tools: ['shell.exec', 'files.write'],
    match: {
      path_regex: '(^|/)\\.config/gcloud/',
    },
    category: 'cloud_credentials',
    resource_class: 'cloud_credentials',
    risk: 'critical',
    message: 'Google Cloud credentials are off-limits.',
  },
  {
    id: 'azure-credentials',
    effect: 'deny',
    tools: ['shell.exec', 'files.write'],
    match: {
      path_regex: '(^|/)\\.azure/',
    },
    category: 'cloud_credentials',
    resource_class: 'cloud_credentials',
    risk: 'critical',
    message: 'Azure credentials are off-limits.',
  },

  // ---------- env / secret files ----------
  {
    id: 'dotenv-read',
    effect: 'require_approval',
    tools: ['shell.exec'],
    match: {
      command_regex:
        '\\b(cat|less|more|head|tail|xxd|base64|hexdump|od)\\b[^\\n]*\\.env(\\.[a-z]+)?\\b',
    },
    category: 'env_secret_access',
    resource_class: 'env_secret',
    risk: 'high',
    message: 'This command reads an .env file that likely contains secrets.',
    safer_alternative:
      'Read only the keys you need via process.env or `grep -v` on key prefixes — not the full file.',
  },

  // ---------- Package & VCS auth tokens ----------
  {
    id: 'npmrc-token',
    effect: 'deny',
    tools: ['shell.exec', 'files.write'],
    match: {
      path_regex: '(^|/)\\.npmrc(\\s|$|"|\')',
    },
    category: 'package_registry_token',
    resource_class: 'package_registry_token',
    risk: 'critical',
    message: 'npm auth tokens are off-limits.',
  },
  {
    id: 'pypirc-token',
    effect: 'deny',
    tools: ['shell.exec', 'files.write'],
    match: {
      path_regex: '(^|/)\\.pypirc(\\s|$|"|\')',
    },
    category: 'package_registry_token',
    resource_class: 'package_registry_token',
    risk: 'critical',
    message: 'PyPI auth tokens are off-limits.',
  },
  {
    id: 'git-credentials',
    effect: 'deny',
    tools: ['shell.exec', 'files.write'],
    match: {
      path_regex: '(^|/)\\.git-credentials(\\s|$|"|\')',
    },
    category: 'developer_auth_token',
    resource_class: 'developer_auth',
    risk: 'critical',
    message: 'Git credentials are off-limits.',
  },
  {
    id: 'gh-cli-token',
    effect: 'deny',
    tools: ['shell.exec'],
    match: {
      command_regex: '\\bgh\\s+auth\\s+token\\b',
    },
    category: 'developer_auth_token',
    resource_class: 'developer_auth',
    risk: 'critical',
    message: 'Printing the GitHub CLI auth token is forbidden.',
  },

  // ---------- Browser profiles ----------
  {
    id: 'browser-profile-delete',
    effect: 'deny',
    tools: ['shell.exec'],
    match: {
      command_regex:
        '\\brm\\s+-[a-zA-Z]*[rRf][a-zA-Z]*\\b[^\\n]*Library/Application Support/(Google/Chrome|Chromium|BraveSoftware|Arc|Firefox)',
    },
    category: 'destructive_browser_profile_modification',
    resource_class: 'browser_profile',
    risk: 'critical',
    message: 'Deleting browser profile data destroys sessions, cookies, and saved credentials.',
  },
  {
    id: 'browser-profile-chromium',
    effect: 'require_approval',
    tools: ['shell.exec', 'files.write'],
    match: {
      path_regex:
        '/Library/Application Support/(Google/Chrome|Chromium|BraveSoftware/Brave-Browser|Arc)/',
    },
    category: 'browser_profile_access',
    resource_class: 'browser_profile',
    risk: 'high',
    message: 'Chromium-family browser profiles contain cookies, sessions, and credential metadata.',
    safer_alternative:
      "Use a disposable profile via `--user-data-dir=$(mktemp -d)` instead of touching the user's default profile.",
  },
  {
    id: 'browser-profile-firefox',
    effect: 'require_approval',
    tools: ['shell.exec', 'files.write'],
    match: {
      path_regex: '/Library/Application Support/Firefox/Profiles/',
    },
    category: 'browser_profile_access',
    resource_class: 'browser_profile',
    risk: 'high',
    message: 'Firefox profiles contain cookies, sessions, and credential metadata.',
    safer_alternative:
      "Use a disposable profile directory rather than the user's default Firefox profile.",
  },

  // ---------- Broad discovery ----------
  {
    id: 'home-secret-grep',
    effect: 'require_approval',
    tools: ['shell.exec'],
    match: {
      // Order-independent: must contain (grep|rg|ag) AND -r AND ($HOME|~/) AND a secret keyword.
      // Lookaheads anchor against the same position so order in the command line is irrelevant.
      command_regex:
        '\\b(grep|rg|ag)\\b(?=[^\\n]*\\s-r\\b)(?=[^\\n]*(\\$HOME|~/))(?=[^\\n]*\\b(password|secret|api[_-]?key|token|BEGIN [A-Z ]+PRIVATE KEY)\\b)',
    },
    category: 'broad_secret_search',
    resource_class: 'unknown_sensitive',
    risk: 'medium',
    message:
      'Recursively searching the home directory for secret-like strings is high-blast-radius.',
    safer_alternative:
      'Scope the search to a specific subdirectory you know contains the file you need.',
  },
];
