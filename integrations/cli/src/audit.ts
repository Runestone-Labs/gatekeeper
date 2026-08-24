import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

type Receipt = {
  sequence?: number;
  previousEntryHash?: string | null;
  entryHash?: string;
  [key: string]: unknown;
};

export interface Verification {
  valid: boolean;
  chainedEntries: number;
  legacyEntries: number;
  lastSequence: number;
  lastEntryHash: string | null;
  errors: string[];
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}

function calculateHash(receipt: Receipt): string {
  const { entryHash: _entryHash, ...hashable } = receipt;
  return `sha256:${createHash('sha256').update(canonicalize(hashable)).digest('hex')}`;
}

export function verifyReceipts(path: string): Verification {
  if (!existsSync(path)) {
    return {
      valid: true,
      chainedEntries: 0,
      legacyEntries: 0,
      lastSequence: 0,
      lastEntryHash: null,
      errors: [],
    };
  }
  const isBundle = statSync(path).isFile();
  const sources: Array<{ name: string; lines: string[] }> = isBundle
    ? [{ name: path, lines: bundleLines(path) }]
    : readdirSync(path)
        .filter((file) => file.endsWith('.jsonl'))
        .sort()
        .map((file) => ({
          name: file,
          lines: readFileSync(join(path, file), 'utf-8').split('\n'),
        }));
  let expected: number | null = isBundle ? null : 1;
  let previous: string | null | undefined = isBundle ? undefined : null;
  let chainedEntries = 0;
  let legacyEntries = 0;
  const errors: string[] = [];
  for (const source of sources) {
    const lines = source.lines;
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].trim()) continue;
      let receipt: Receipt;
      try {
        receipt = JSON.parse(lines[index]) as Receipt;
      } catch {
        errors.push(`${source.name}:${index + 1}: invalid JSON`);
        continue;
      }
      if (!receipt.sequence || !receipt.entryHash) {
        legacyEntries++;
        continue;
      }
      chainedEntries++;
      if (expected === null) {
        expected = receipt.sequence;
        previous = receipt.previousEntryHash ?? null;
      }
      if (receipt.sequence !== expected) errors.push(`${source.name}:${index + 1}: sequence gap`);
      if ((receipt.previousEntryHash ?? null) !== previous) {
        errors.push(`${source.name}:${index + 1}: previous-entry hash mismatch`);
      }
      if (calculateHash(receipt) !== receipt.entryHash) {
        errors.push(`${source.name}:${index + 1}: entry hash mismatch`);
      }
      expected = receipt.sequence + 1;
      previous = receipt.entryHash;
    }
  }
  return {
    valid: errors.length === 0,
    chainedEntries,
    legacyEntries,
    lastSequence: (expected ?? 1) - 1,
    lastEntryHash: previous ?? null,
    errors,
  };
}

function bundleLines(path: string): string[] {
  const content = readFileSync(path, 'utf-8').trim();
  if (!content) return [];
  try {
    const parsed = JSON.parse(content) as unknown;
    const entries = Array.isArray(parsed)
      ? parsed
      : parsed &&
          typeof parsed === 'object' &&
          Array.isArray((parsed as { events?: unknown }).events)
        ? (parsed as { events: unknown[] }).events
        : parsed &&
            typeof parsed === 'object' &&
            Array.isArray((parsed as { entries?: unknown }).entries)
          ? (parsed as { entries: unknown[] }).entries
          : null;
    if (entries) {
      return entries
        .filter((entry): entry is Receipt => !!entry && typeof entry === 'object')
        .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
        .map((entry) => JSON.stringify(entry));
    }
  } catch {
    // Fall through to JSONL parsing.
  }
  return content.split('\n');
}
