import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalize, computeHash } from '../utils.js';
import type { AuditEntry, PendingApproval } from '../types.js';
import type { CloudEventV1, CloudReviewSummary } from './schemas.js';

const EMBEDDED_SECRETS: RegExp[] = [
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9_-]{8,}\b/gi,
  /\b(?:ghp|gho|github_pat|xox[pboa])_[A-Za-z0-9_-]{8,}\b/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/gi,
  /\b(?:password|passwd|secret|token|api[_-]?key|authorization)\s*[=:]\s*[^\s,;]+/gi,
  /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s/@:]+:[^\s/@]+@/gi,
];

const SENSITIVE_FIELD =
  /password|passwd|secret|token|api[_-]?key|auth|credential|header|cookie|body|content/i;

export function scrubCloudString(input: string, maxLength = 256): string {
  let output = input;
  for (const pattern of EMBEDDED_SECRETS) {
    output = output.replace(pattern, (match) => {
      if (match.includes('://')) return match.replace(/\/\/[^@]+@/, '//[REDACTED]@');
      const separator = match.match(/^[^=:]+[=:]/)?.[0];
      return separator ? `${separator}[REDACTED]` : '[REDACTED]';
    });
  }

  const home = homedir();
  if (home) output = output.split(home).join('$HOME');
  output = output
    .replace(/\/(?:Users|home)\/[^/\s]+/g, '$HOME')
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/g, '$HOME');
  if (output.length > maxLength) output = `${output.slice(0, maxLength)}…`;
  return output;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function shellSummary(args: Record<string, unknown>): CloudReviewSummary {
  const command = stringValue(args.command) ?? stringValue(args.cmd) ?? '';
  const argv = Array.isArray(args.args)
    ? args.args.filter((value): value is string => typeof value === 'string')
    : splitCommand(command);
  const executable = scrubCloudString(
    argv.shift() ?? basename(command.split(/\s+/)[0] ?? 'unknown'),
    256
  );

  return {
    kind: 'shell',
    executable,
    arguments: argv.slice(0, 24).map((value) => scrubCloudString(value, 256)),
    ...(stringValue(args.cwd)
      ? { cwd: scrubCloudString(resolve(stringValue(args.cwd)!), 512) }
      : {}),
  };
}

function splitCommand(command: string): string[] {
  // This is display-only tokenization. It intentionally does not attempt shell
  // evaluation, substitution, glob expansion, or quote-perfect reconstruction.
  return (
    command
      .match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
      ?.map((part) => part.replace(/^(['"])(.*)\1$/, '$2')) ?? []
  );
}

function fileSummary(args: Record<string, unknown>): CloudReviewSummary {
  const rawPath = stringValue(args.path) ?? stringValue(args.file) ?? 'unknown';
  const content = stringValue(args.content) ?? stringValue(args.data);
  const declaredBytes = typeof args.byteCount === 'number' ? args.byteCount : undefined;
  return {
    kind: 'file',
    path: scrubCloudString(resolve(rawPath), 512),
    ...(content !== undefined
      ? { byteCount: Buffer.byteLength(content), contentHash: `sha256:${computeHash(content)}` }
      : declaredBytes !== undefined
        ? { byteCount: Math.max(0, Math.floor(declaredBytes)) }
        : {}),
  };
}

function httpSummary(args: Record<string, unknown>): CloudReviewSummary {
  const rawUrl = stringValue(args.url) ?? '';
  let origin = 'invalid-url';
  try {
    origin = new URL(rawUrl).origin;
  } catch {
    // Keep the invalid value out of Cloud; it may contain arbitrary input.
  }
  return {
    kind: 'http',
    method: scrubCloudString(stringValue(args.method)?.toUpperCase() ?? 'GET', 16),
    origin: scrubCloudString(origin, 512),
  };
}

export function createCloudReviewSummary(
  tool: string,
  args: Record<string, unknown>,
  allowlistedCustomFields: string[] = []
): CloudReviewSummary {
  if (tool === 'shell.exec' || /(?:^|\.)shell|bash|command/i.test(tool)) return shellSummary(args);
  if (tool === 'files.write' || /(?:^|\.)(?:file|fs)(?:\.|$)/i.test(tool)) return fileSummary(args);
  if (tool === 'http.request' || /(?:^|\.)(?:http|fetch|web)(?:\.|$)/i.test(tool))
    return httpSummary(args);

  const fields: Record<string, string | number | boolean | null> = {};
  for (const key of allowlistedCustomFields) {
    if (SENSITIVE_FIELD.test(key)) continue;
    const value = args[key];
    if (typeof value === 'string') fields[key] = scrubCloudString(value, 256);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null)
      fields[key] = value;
  }
  return { kind: 'custom', fields };
}

export function computeApprovalActionDigest(approval: PendingApproval): string {
  return `sha256:${computeHash(
    canonicalize({
      approvalId: approval.id,
      tool: approval.toolName,
      canonicalArgs: approval.canonicalArgs,
      actor: approval.actor,
      requestId: approval.requestId,
      policyHash: approval.policyHash ?? 'unknown',
      expiresAt: approval.expiresAt,
    })
  )}`;
}

export function auditEntryToCloudEvent(entry: AuditEntry, instanceId: string): CloudEventV1 {
  const tokenCount = entry.usage
    ? entry.usage.inputTokens +
      entry.usage.outputTokens +
      (entry.usage.cacheReadTokens ?? 0) +
      (entry.usage.cacheCreationTokens ?? 0)
    : undefined;
  const approvalStatus = entry.riskFlags
    .find((flag) => flag.startsWith('action:'))
    ?.slice('action:'.length);

  return {
    schemaVersion: 'cloud-event.v1',
    eventId: randomUUID(),
    instanceId,
    requestId: scrubCloudString(entry.requestId, 256),
    ...(entry.actor.runId ? { runId: scrubCloudString(entry.actor.runId, 256) } : {}),
    actorName: scrubCloudString(entry.actor.name, 128),
    actorRole: scrubCloudString(entry.actor.role, 128),
    tool: scrubCloudString(entry.tool, 256),
    decision: entry.decision,
    ...(entry.reasonCode ? { reasonCode: scrubCloudString(entry.reasonCode, 128) } : {}),
    riskCategories: entry.riskFlags.slice(0, 32).map((flag) => scrubCloudString(flag, 128)),
    policyHash: entry.policyHash,
    occurredAt: entry.timestamp,
    ...(entry.executionReceipt
      ? { durationMs: Math.max(0, entry.executionReceipt.durationMs) }
      : {}),
    ...(entry.costUsd !== undefined ? { costUsd: entry.costUsd } : {}),
    ...(tokenCount !== undefined ? { tokenCount } : {}),
    ...(entry.approvalId ? { approvalId: entry.approvalId } : {}),
    ...(approvalStatus ? { approvalStatus } : {}),
    ...(entry.sequence !== undefined ? { localSequence: entry.sequence } : {}),
    ...(entry.sequence !== undefined
      ? { localPreviousEntryHash: entry.previousEntryHash ?? null }
      : {}),
    ...(entry.entryHash ? { localEntryHash: entry.entryHash } : {}),
  };
}
