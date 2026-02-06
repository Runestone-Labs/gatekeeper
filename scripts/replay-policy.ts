import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { evaluateTool } from '../src/policy/evaluate.js';
import { YamlPolicySource } from '../src/providers/yaml-policy.js';
import { canonicalize, computeHash } from '../src/utils.js';

type ArgsMap = Map<string, string>;

function parseArgs(argv: string[]): ArgsMap {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      args.set(key.slice(2), 'true');
      continue;
    }
    args.set(key.slice(2), value);
    i += 1;
  }
  return args;
}

function usage(): void {
  console.log(
    [
      'Usage:',
      '  tsx scripts/replay-policy.ts --log <audit.jsonl> --request-id <id> --args <args.json> [--policy <policy.yaml>]',
      '',
      'Example:',
      '  tsx scripts/replay-policy.ts --log data/audit/2026-02-01.jsonl --request-id 123 --args /tmp/args.json',
    ].join('\n')
  );
}

const args = parseArgs(process.argv.slice(2));
const logPath = args.get('log');
const requestId = args.get('request-id');
const argsPath = args.get('args');
const policyPath = args.get('policy') || resolve('policy.yaml');

if (!logPath || !requestId || !argsPath) {
  usage();
  process.exit(1);
}

const logContent = readFileSync(logPath, 'utf-8');
const entries = logContent
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const requestEntry = entries.find(
  (entry) =>
    entry.requestId === requestId && ['allow', 'approve', 'deny'].includes(entry.decision)
);

if (!requestEntry) {
  console.error(`No request entry found for requestId ${requestId}`);
  process.exit(2);
}

const argsData = JSON.parse(readFileSync(argsPath, 'utf-8')) as Record<string, unknown>;
const argsHash = computeHash(canonicalize(argsData));

if (requestEntry.argsHash && requestEntry.argsHash !== argsHash) {
  console.error('Args hash mismatch. Provided args do not match audit record.');
  process.exit(3);
}

const policySource = new YamlPolicySource(policyPath);
const policy = await policySource.load();
const policyHash = policySource.getHash();

if (requestEntry.policyHash && requestEntry.policyHash !== policyHash) {
  console.warn(
    `Policy hash mismatch. Log has ${requestEntry.policyHash}, current policy is ${policyHash}.`
  );
}

const evaluation = evaluateTool(requestEntry.tool, argsData, policy, {
  requestId: requestEntry.requestId,
  actor: requestEntry.actor,
  args: argsData,
  origin: requestEntry.origin,
  taint: requestEntry.taint,
  contextRefs: requestEntry.contextRefs,
});

const match =
  evaluation.decision === requestEntry.decision &&
  evaluation.reasonCode === requestEntry.reasonCode;

console.log(
  JSON.stringify(
    {
      requestId,
      tool: requestEntry.tool,
      logged: {
        decision: requestEntry.decision,
        reasonCode: requestEntry.reasonCode,
        policyHash: requestEntry.policyHash,
      },
      replayed: {
        decision: evaluation.decision,
        reasonCode: evaluation.reasonCode,
        policyHash,
      },
      match,
    },
    null,
    2
  )
);

if (!match) {
  process.exit(4);
}
