import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalize, computeHash } from '../src/utils.js';
import { createCapabilityToken, CapabilityTokenPayload } from '../src/capabilities/token.js';

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
      '  tsx scripts/create-capability.ts --tool <tool> --args <args.json> [--ttl <seconds>] [--actor-role <role>] [--actor-name <name>]',
      '',
      'Example:',
      '  tsx scripts/create-capability.ts --tool shell.exec --args /tmp/args.json --ttl 3600',
    ].join('\n')
  );
}

const args = parseArgs(process.argv.slice(2));
const tool = args.get('tool');
const argsPath = args.get('args');
const ttlSeconds = args.get('ttl') ? Number(args.get('ttl')) : 3600;
const actorRole = args.get('actor-role');
const actorName = args.get('actor-name');

if (!tool || !argsPath || Number.isNaN(ttlSeconds)) {
  usage();
  process.exit(1);
}

const argsData = JSON.parse(readFileSync(resolve(argsPath), 'utf-8')) as Record<string, unknown>;
const argsHash = computeHash(canonicalize(argsData));
const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

const payload: CapabilityTokenPayload = {
  tool,
  argsHash,
  expiresAt,
};

if (actorRole) payload.actorRole = actorRole;
if (actorName) payload.actorName = actorName;

const token = createCapabilityToken(payload);

console.log(
  JSON.stringify(
    {
      token,
      payload,
    },
    null,
    2
  )
);
