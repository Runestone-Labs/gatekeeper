#!/usr/bin/env node
/**
 * Distribution readiness gate for @runestone-labs/gatekeeper-client.
 *
 * Runs before `npm publish` (locally via `npm run distribution-check` or in CI).
 * Exits non-zero on failure with a readable report. Covers the failure modes that
 * are one-way doors for a published package:
 *
 *   1. package.json required fields present + shape is sane
 *   2. `files` allowlist is restrictive (no "*", ".", or "**" globs)
 *   3. `prepublishOnly` script exists so `npm publish` rebuilds dist/
 *   4. Build artifacts exist (dist/index.js, dist/index.d.ts)
 *   5. `npm pack --dry-run` bundle contains only dist/, README.md, LICENSE, package.json
 *      — no .ts source, no tests, no tsconfig, no vitest config
 *   6. CHANGELOG.md at repo root has an entry for the current package version
 *
 * Does NOT add runtime deps. Pure Node ESM.
 */

import { readFile, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = resolve(__dirname, '..');          // integrations/typescript-client
const REPO_ROOT = resolve(PKG_DIR, '..', '..');    // runestone-gatekeeper
const PKG_JSON_PATH = join(PKG_DIR, 'package.json');
const CHANGELOG_PATH = join(REPO_ROOT, 'CHANGELOG.md');

// Allowed file patterns in the published bundle. Anything matching these is fine;
// anything else is flagged. Paths are relative to the package root.
const ALLOWED_PATTERNS = [
  /^package\.json$/,
  /^README\.md$/i,
  /^LICENSE(\..+)?$/i,
  /^dist\//,
];

// File patterns that must NOT appear in the published bundle.
const FORBIDDEN_PATTERNS = [
  { name: 'TypeScript source (.ts)', re: /(^|\/)[^/]+\.ts$/, except: /\.d\.ts$/ },
  { name: 'test files', re: /\.test\.(ts|js|mjs)$/ },
  { name: 'tsconfig', re: /tsconfig.*\.json$/ },
  { name: 'vitest config', re: /vitest\.config\./ },
  { name: '.npmignore (should not be in bundle)', re: /(^|\/)\.npmignore$/ },
];

// ---

const failures = [];
const warnings = [];

function fail(check, msg) {
  failures.push({ check, msg });
}
function warn(check, msg) {
  warnings.push({ check, msg });
}

async function fileExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// --- Checks ---

async function checkPackageJsonFields(pkg) {
  const required = ['name', 'version', 'description', 'license', 'main', 'types', 'exports', 'files', 'repository'];
  for (const field of required) {
    if (pkg[field] === undefined) {
      fail('package.json fields', `missing required field: ${field}`);
    }
  }

  if (pkg.name && !pkg.name.startsWith('@')) {
    warn('package.json fields', `name "${pkg.name}" is not scoped; expected "@runestone-labs/..."`);
  }

  if (pkg.main && !pkg.main.startsWith('dist/')) {
    fail('package.json fields', `main "${pkg.main}" should point into dist/, not source`);
  }
  if (pkg.types && !pkg.types.startsWith('dist/')) {
    fail('package.json fields', `types "${pkg.types}" should point into dist/, not source`);
  }

  if (pkg.exports && typeof pkg.exports === 'object') {
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      if (typeof target === 'object' && target !== null) {
        for (const [cond, path] of Object.entries(target)) {
          if (typeof path === 'string' && !path.startsWith('./dist/')) {
            fail('exports map', `exports["${subpath}"].${cond} = "${path}" should point into ./dist/`);
          }
        }
      }
    }
  }
}

async function checkFilesAllowlist(pkg) {
  if (!Array.isArray(pkg.files)) {
    fail('files allowlist', '`files` field must be an array');
    return;
  }
  if (pkg.files.length === 0) {
    fail('files allowlist', '`files` is empty (publishes fallback set — unsafe)');
    return;
  }
  for (const entry of pkg.files) {
    if (entry === '.' || entry === '*' || entry === '**' || entry === '**/*') {
      fail('files allowlist', `entry "${entry}" is too permissive — will ship everything`);
    }
  }
}

async function checkPrepublishBuild(pkg) {
  const scripts = pkg.scripts || {};
  if (!scripts.prepublishOnly && !scripts.prepare) {
    fail(
      'prepublishOnly',
      'neither `prepublishOnly` nor `prepare` script set — dist/ may be stale at publish time',
    );
  }
}

async function checkBuildArtifacts() {
  const indexJs = join(PKG_DIR, 'dist', 'index.js');
  const indexDts = join(PKG_DIR, 'dist', 'index.d.ts');

  if (!(await fileExists(indexJs))) {
    fail(
      'build artifacts',
      'dist/index.js missing — run `npm run build` (or rely on prepublishOnly) before publishing',
    );
  }
  if (!(await fileExists(indexDts))) {
    fail(
      'build artifacts',
      'dist/index.d.ts missing — package has no type declarations',
    );
  }
}

function runNpmPackDryRun() {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: PKG_DIR,
    encoding: 'utf-8',
  });
  const parsed = JSON.parse(out);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!entry || !Array.isArray(entry.files)) {
    throw new Error('unexpected npm pack output shape');
  }
  return entry.files.map((f) => f.path);
}

async function checkPackContents() {
  let files;
  try {
    files = runNpmPackDryRun();
  } catch (e) {
    fail('pack contents', `npm pack --dry-run failed: ${e.message}`);
    return;
  }

  for (const file of files) {
    const allowed = ALLOWED_PATTERNS.some((re) => re.test(file));
    if (!allowed) {
      fail('pack contents', `unexpected file in bundle: ${file}`);
    }
    for (const forbidden of FORBIDDEN_PATTERNS) {
      if (forbidden.except && forbidden.except.test(file)) continue;
      if (forbidden.re.test(file)) {
        fail('pack contents', `forbidden (${forbidden.name}): ${file}`);
      }
    }
  }

  if (!files.some((f) => /^dist\/index\.js$/.test(f))) {
    fail('pack contents', 'dist/index.js not in bundle');
  }
  if (!files.some((f) => /^dist\/index\.d\.ts$/.test(f))) {
    fail('pack contents', 'dist/index.d.ts not in bundle');
  }
}

async function checkChangelog(pkg) {
  if (!(await fileExists(CHANGELOG_PATH))) {
    fail('changelog', `CHANGELOG.md not found at repo root (${CHANGELOG_PATH})`);
    return;
  }
  const body = await readFile(CHANGELOG_PATH, 'utf-8');
  // Accept "## [0.3.0]" or "## 0.3.0" or "## v0.3.0"
  const version = pkg.version;
  const versionRe = new RegExp(
    `^##\\s+\\[?v?${version.replace(/\./g, '\\.')}\\]?(\\s|$)`,
    'm',
  );
  if (!versionRe.test(body)) {
    fail(
      'changelog',
      `no "## [${version}]" or equivalent entry in CHANGELOG.md for current version`,
    );
  }
}

// --- Main ---

async function main() {
  console.log(`Distribution readiness check for package at ${PKG_DIR}\n`);

  const pkg = JSON.parse(await readFile(PKG_JSON_PATH, 'utf-8'));
  console.log(`  package: ${pkg.name}@${pkg.version}\n`);

  await checkPackageJsonFields(pkg);
  await checkFilesAllowlist(pkg);
  await checkPrepublishBuild(pkg);
  await checkBuildArtifacts();
  await checkPackContents();
  await checkChangelog(pkg);

  if (warnings.length > 0) {
    console.log(`Warnings (${warnings.length}):`);
    for (const w of warnings) {
      console.log(`  - [${w.check}] ${w.msg}`);
    }
    console.log();
  }

  if (failures.length === 0) {
    console.log(`PASS — distribution ready to publish.`);
    process.exit(0);
  }

  console.log(`FAIL — ${failures.length} issue(s):\n`);
  for (const f of failures) {
    console.log(`  - [${f.check}] ${f.msg}`);
  }
  console.log();
  process.exit(1);
}

main().catch((e) => {
  console.error('distribution-check crashed:', e);
  process.exit(2);
});
