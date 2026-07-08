/**
 * Security-critical translation layer — PURE, dependency-free, and the focus of
 * the adversarial test suite.
 *
 * This is where a gatekeeper decision becomes an MCP tool result. The whole
 * value of routing an MCP client through gatekeeper evaporates if this layer
 * ever (a) presents a DENY or pending APPROVAL as a successful result, or
 * (b) defaults OPEN on a malformed/unexpected response. So the rules here are
 * deliberately strict and fail-closed:
 *
 *   allow    → success result with the tool output
 *   deny     → isError result (the agent must see it was blocked)
 *   approve  → isError result that says NOTHING executed (a pending approval is
 *              not a completed action — never silently "succeed" or block)
 *   anything else (missing/unknown decision, null, non-object) → treated as a
 *              DENY ("fail closed"); we never assume allow.
 */

import type { GatekeeperResult } from '@runestone-labs/gatekeeper-client';

/** Minimal MCP CallToolResult shape (avoids importing the SDK into the pure core). */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
}

function text(s: string, isError: boolean): ToolResult {
  return { content: [{ type: 'text', text: s }], isError };
}

/**
 * Gatekeeper tool names are dot-segmented lowercase identifiers (e.g.
 * `shell.exec`, `http.request`, `memory.query`). The client interpolates the
 * name straight into a URL path (`/tool/${tool}`), so an unvalidated name with
 * a slash or `..` could traverse to a DIFFERENT endpoint (e.g. `/tool/../admin`
 * → `/admin`). Reject anything that isn't a strict dotted identifier.
 */
export const TOOL_NAME_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/;

export function isValidToolName(name: unknown): name is string {
  return typeof name === 'string' && name.length <= 64 && TOOL_NAME_RE.test(name);
}

export function assertValidToolName(name: unknown): asserts name is string {
  if (!isValidToolName(name)) {
    throw new Error(
      `invalid gatekeeper tool name ${JSON.stringify(name)} — must match ${TOOL_NAME_RE} (no slashes, no traversal)`
    );
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Scrub a free-text string before it reaches the MCP client.
 *
 * ONE redaction routine, shared by BOTH the decision paths (deny/approve carry
 * gatekeeper-supplied explanations) and the error path. Gatekeeper sits on the
 * trusted side, but its free-text fields can echo internal hosts, DSNs, file
 * paths, or reflected credentials — none of which the MCP client should see.
 * Over-redaction of failure/explanation text is acceptable; we deliberately do
 * NOT run this over a successful tool's OUTPUT (that's the data the caller asked
 * for) or over structured ids like approvalId (a UUID the user needs verbatim).
 */
export function sanitize(input: string, baseUrl?: string): string {
  let s = input;

  // Configured gatekeeper origin + bare host/IP (case-insensitive).
  if (baseUrl) {
    s = s.replace(new RegExp(escapeRegExp(baseUrl), 'gi'), '<gatekeeper>');
    try {
      const u = new URL(baseUrl);
      if (u.host) s = s.replace(new RegExp(escapeRegExp(u.host), 'gi'), '<gatekeeper>');
      if (u.hostname && u.hostname !== u.host)
        s = s.replace(new RegExp(escapeRegExp(u.hostname), 'gi'), '<gatekeeper>');
    } catch {
      // baseUrl wasn't a parseable URL — the substring scrub above still ran.
    }
  }

  return (
    s
      // URL userinfo (scheme://user:pass@host) regardless of host.
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1<redacted>@')
      // Bearer tokens (no colon after the scheme word).
      .replace(/bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
      // Labelled secrets, tolerating an intervening quote (JSON: "token":"..").
      .replace(
        /(authorization|api[-_]?key|access[-_]?token|token|secret|password|passwd|pwd)["']?\s*[:=]\s*["']?[^\s"',}]+/gi,
        '$1=<redacted>'
      )
      // JWTs.
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<redacted-jwt>')
      // AWS access key ids.
      .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{12,}\b/g, '<redacted>')
      // Known secret prefixes.
      .replace(
        /\b(?:sk-[a-z]*-?|re_|pk_(?:live|test)_|gh[oprsu]_|xox[baprs]-)[A-Za-z0-9._-]{6,}/gi,
        '<redacted>'
      )
      // Generic solid 32+ alnum blobs (hex hashes, plain tokens). Excludes
      // hyphens/underscores so UUIDs (and thus approvalIds) survive intact.
      .replace(/\b[A-Za-z0-9]{32,}\b/g, '<redacted>')
  );
}

/**
 * Convert a gatekeeper result into an MCP tool result, fail-closed. `baseUrl`
 * (when supplied) lets the sanitizer scrub the gatekeeper host out of any
 * free-text the decision carries.
 */
export function decisionToToolResult(result: unknown, baseUrl?: string): ToolResult {
  if (!result || typeof result !== 'object') {
    return text(
      'Gatekeeper returned no/!object response — treating as DENIED (fail-closed).',
      true
    );
  }
  const r = result as Partial<GatekeeperResult>;
  const clean = (v: string | undefined): string | undefined =>
    v === undefined ? undefined : sanitize(v, baseUrl);

  switch (r.decision) {
    case 'allow': {
      // Surface the tool output. `result` may legitimately be undefined (a
      // side-effecting tool with no payload) — that's still a success. The
      // output is the DATA the caller asked for, so it is NOT sanitized; but
      // serialization is guarded so this pure function fails closed on its own
      // (independent of the caller's try/catch) for a hostile payload.
      const payload = r.result === undefined ? { ok: true } : r.result;
      let body: string;
      try {
        body = JSON.stringify(payload, null, 2);
      } catch {
        return text(
          'Gatekeeper allow result was not serializable — treating as DENIED (fail-closed).',
          true
        );
      }
      if (typeof body !== 'string') {
        return text(
          'Gatekeeper allow result was empty/non-serializable — treating as DENIED (fail-closed).',
          true
        );
      }
      return text(body, false);
    }
    case 'deny': {
      const code = clean(r.reasonCode ?? r.denial?.reasonCode) ?? 'DENIED';
      const why =
        clean(r.humanExplanation ?? r.denial?.humanExplanation ?? r.error) ??
        'no explanation provided';
      const fix = clean(r.remediation ?? r.denial?.remediation);
      return text(`DENIED [${code}]: ${why}${fix ? `\nRemediation: ${fix}` : ''}`, true);
    }
    case 'approve': {
      // approvalId/expiresAt are structured identifiers the user needs verbatim
      // to act on the approval, so they pass through; only the free-text reason
      // is sanitized.
      const id = r.approvalId ?? r.approvalRequest?.approvalId ?? '(unknown)';
      const expires = r.expiresAt ?? r.approvalRequest?.expiresAt ?? '(unknown)';
      const why =
        clean(r.humanExplanation ?? r.approvalRequest?.humanExplanation) ??
        'human approval required';
      // CRITICAL: isError=true and explicit "did NOT run" so the agent never
      // treats a pending approval as a completed action.
      return text(
        `APPROVAL REQUIRED — this call did NOT execute.\n` +
          `approvalId: ${id}\nexpires: ${expires}\nreason: ${why}\n` +
          `A human must approve it in Gatekeeper; re-issue the call only after approval.`,
        true
      );
    }
    default:
      // Unknown/missing decision: fail closed.
      return text(
        `Gatekeeper returned an unrecognized decision (${JSON.stringify(r.decision)}) — treating as DENIED (fail-closed).`,
        true
      );
  }
}

/**
 * Turn a thrown error (network failure, gatekeeper 5xx, etc.) into a fail-closed
 * error result, run through the shared sanitizer so the gatekeeper host / any
 * embedded credential never reaches the MCP client.
 */
export function errorToToolResult(err: unknown, baseUrl?: string): ToolResult {
  const raw = err instanceof Error ? err.message : String(err);
  return text(
    `Gatekeeper call failed — treating as DENIED (fail-closed): ${sanitize(raw, baseUrl)}`,
    true
  );
}
