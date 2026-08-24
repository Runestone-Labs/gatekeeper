#!/usr/bin/env node
/**
 * Runestone Gatekeeper — Claude Code PreToolUse hook.
 *
 * Wires Claude Code's tool-use lifecycle into Gatekeeper's policy engine.
 * For each Bash / Write / Edit / WebFetch invocation, this hook:
 *
 *   1. Reads the hook envelope from stdin (Claude Code sends JSON).
 *   2. Maps the Claude Code tool to a Gatekeeper tool + args.
 *   3. Calls Gatekeeper's `POST /tool/:toolName` with `dryRun: true` so
 *      Gatekeeper evaluates policy without trying to execute.
 *   4. If approval is required for an exactly representable action, registers
 *      the real held action with an idempotency key. Gatekeeper executes it
 *      exactly once after the local or Cloud decision is applied.
 *   5. Translates the Gatekeeper decision into Claude Code's hook output
 *      shape (`{ decision: "block", reason: "..." }` to block; exit 0 to
 *      allow).
 *
 * Failure modes:
 *   - Server unreachable -> fail-open by default (exit 0). Set
 *     `GATEKEEPER_FAIL_CLOSED=1` to flip to fail-closed.
 *   - Unmapped tool -> exit 0 (don't gate what we don't understand).
 *
 * Environment:
 *   GATEKEEPER_BASE_URL       Default: http://127.0.0.1:3847
 *   GATEKEEPER_AGENT_NAME     Default: claude-code
 *   GATEKEEPER_AGENT_ROLE     Default: claude-code
 *   GATEKEEPER_FAIL_CLOSED    "1" or "true" to fail closed when server is down
 *   GATEKEEPER_TIMEOUT_MS     Default: 2000
 *   GATEKEEPER_RUN_ID         Optional run id for per-run budgets (default: session id)
 *   GATEKEEPER_DEBUG          "1" to log decisions to stderr
 */

import { createHash, randomUUID } from 'node:crypto';

interface ClaudeCodeHookInput {
  session_id?: string;
  transcript_path?: string;
  hook_event_name?: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
}

interface GatekeeperEvaluationResponse {
  decision: 'allow' | 'approve' | 'deny';
  reasonCode?: string;
  humanExplanation?: string;
  remediation?: string;
  riskFlags?: string[];
  dryRun?: boolean;
  approvalId?: string;
  expiresAt?: string;
  message?: string;
}

interface MappedRequest {
  tool: string;
  args: Record<string, unknown>;
  /** False when Claude's action cannot safely be reproduced by Gatekeeper. */
  executableOnApproval?: boolean;
}

/**
 * Read configuration fresh on every invocation, not at module load. Tests
 * mutate `process.env` between runs, and Claude Code may launch the hook
 * inside a long-lived process where users update env vars between sessions.
 */
function readConfig(): {
  baseUrl: string;
  agentName: string;
  agentRole: string;
  runId?: string;
  failClosed: boolean;
  timeoutMs: number;
  debug: boolean;
} {
  return {
    baseUrl: process.env.GATEKEEPER_BASE_URL ?? 'http://127.0.0.1:3847',
    agentName: process.env.GATEKEEPER_AGENT_NAME ?? 'claude-code',
    agentRole: process.env.GATEKEEPER_AGENT_ROLE ?? 'claude-code',
    runId: process.env.GATEKEEPER_RUN_ID || undefined,
    failClosed:
      process.env.GATEKEEPER_FAIL_CLOSED === '1' || process.env.GATEKEEPER_FAIL_CLOSED === 'true',
    timeoutMs: Number.parseInt(process.env.GATEKEEPER_TIMEOUT_MS ?? '2000', 10),
    debug: process.env.GATEKEEPER_DEBUG === '1',
  };
}

/**
 * Claude Code → Gatekeeper tool mapping. Returns null when the tool is not
 * gated (e.g. Read, MCP tools) — caller should exit 0 in that case.
 */
export function mapClaudeCodeTool(
  toolName: string,
  toolInput: Record<string, unknown>
): MappedRequest | null {
  switch (toolName) {
    case 'Bash':
      return {
        tool: 'shell.exec',
        args: pickFields(toolInput, ['command', 'cwd', 'timeoutMs', 'timeout']),
      };

    case 'Write':
      return {
        tool: 'files.write',
        args: {
          path: toolInput.file_path,
          content: toolInput.content,
        },
      };

    case 'Edit':
      // Edits are gated by path. We pass `new_string` as content for path-based
      // boundary checks; full-content inspection is out of scope for v0.1.
      return {
        tool: 'files.write',
        args: {
          path: toolInput.file_path,
          content: toolInput.new_string ?? '',
        },
        // `files.write` would replace the whole file with `new_string`; never
        // register that as an executable approval for a Claude Edit action.
        executableOnApproval: false,
      };

    case 'WebFetch':
      return {
        tool: 'http.request',
        args: { url: toolInput.url, method: 'GET' },
      };

    // Read, Glob, Grep, NotebookEdit, MCP tools, etc. → not gated in v0.1.
    default:
      return null;
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
    return `{${entries.join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? 'null' : encoded;
}

function approvalIdempotencyKey(
  sessionId: string | undefined,
  toolName: string,
  args: Record<string, unknown>
): string {
  const digest = createHash('sha256')
    .update(stableJson({ sessionId: sessionId ?? null, toolName, args }))
    .digest('hex');
  return `claude-code:${digest}`;
}

function makeRequestBody(
  args: Record<string, unknown>,
  opts: {
    agentName: string;
    agentRole: string;
    sessionId?: string;
    runId?: string;
  },
  dryRun: boolean,
  idempotencyKey?: string
): Record<string, unknown> {
  const runId = opts.runId || opts.sessionId;
  return {
    requestId: randomUUID(),
    actor: {
      type: 'agent' as const,
      name: opts.agentName,
      role: opts.agentRole,
      ...(runId ? { runId } : {}),
    },
    args,
    context: opts.sessionId ? { conversationId: opts.sessionId } : undefined,
    origin: 'model_inferred' as const,
    dryRun,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

async function postToolRequest(
  baseUrl: string,
  toolName: string,
  body: Record<string, unknown>,
  timeoutMs: number
): Promise<GatekeeperEvaluationResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/tool/${encodeURIComponent(toolName)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const response = (await res.json()) as GatekeeperEvaluationResponse;
    if (!res.ok) {
      throw new Error(
        `Gatekeeper returned HTTP ${res.status}${response.humanExplanation ? `: ${response.humanExplanation}` : ''}`
      );
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}

function pickFields(obj: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of fields) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
}

/**
 * Call Gatekeeper with `dryRun: true` and return the evaluation. Throws on
 * network error or non-2xx status; the caller decides fail-open vs fail-closed.
 */
export async function evaluate(
  baseUrl: string,
  toolName: string,
  args: Record<string, unknown>,
  opts: {
    agentName: string;
    agentRole: string;
    timeoutMs: number;
    sessionId?: string;
    runId?: string;
  }
): Promise<GatekeeperEvaluationResponse> {
  return postToolRequest(baseUrl, toolName, makeRequestBody(args, opts, true), opts.timeoutMs);
}

/** Register the real, executable held action after a dry-run approval decision. */
export async function registerHeldAction(
  baseUrl: string,
  toolName: string,
  args: Record<string, unknown>,
  opts: {
    agentName: string;
    agentRole: string;
    timeoutMs: number;
    sessionId?: string;
    runId?: string;
  }
): Promise<GatekeeperEvaluationResponse> {
  const idempotencyKey = approvalIdempotencyKey(opts.sessionId, toolName, args);
  const response = await postToolRequest(
    baseUrl,
    toolName,
    makeRequestBody(args, opts, false, idempotencyKey),
    opts.timeoutMs
  );
  if (response.decision !== 'approve' || !response.approvalId || !response.expiresAt) {
    throw new Error('Gatekeeper did not return a bound approval hold');
  }
  return response;
}

/**
 * Translate a Gatekeeper evaluation into Claude Code's hook output. Allow
 * returns null (exit 0). Deny / approve return a JSON block that Claude Code
 * surfaces back to the model so it can pivot.
 */
export function buildHookResponse(
  evaluation: GatekeeperEvaluationResponse,
  mapped: MappedRequest,
  heldAction?: GatekeeperEvaluationResponse
): { exit: number; stdout?: string } {
  if (evaluation.decision === 'allow') {
    return { exit: 0 };
  }

  const lines: string[] = [];
  lines.push(
    `Gatekeeper ${evaluation.decision === 'deny' ? 'denied' : 'requires approval for'} this tool call.`
  );
  if (evaluation.humanExplanation) lines.push(evaluation.humanExplanation);
  if (evaluation.remediation) lines.push(evaluation.remediation);
  if (evaluation.reasonCode) lines.push(`(reasonCode: ${evaluation.reasonCode})`);
  if (heldAction?.approvalId) {
    lines.push(
      `Tool: ${mapped.tool}. Approval ${heldAction.approvalId} is pending until ${heldAction.expiresAt}. Gatekeeper will execute the exact held action once if approved; do not retry it in Claude Code.`
    );
  } else if (evaluation.decision === 'approve' && mapped.executableOnApproval === false) {
    lines.push(
      `Tool: ${mapped.tool}. This Claude Code action cannot be reproduced safely by Gatekeeper, so no executable hold was created. Apply it manually or change policy.`
    );
  } else {
    lines.push(
      `Tool: ${mapped.tool}. To proceed, run this manually outside Claude Code or update Gatekeeper policy.`
    );
  }

  const reason = lines.join('\n');

  // Claude Code's PreToolUse hook contract: stdout JSON with decision=block
  // surfaces the reason to the model, which can then choose a different path.
  return {
    exit: 0,
    stdout: JSON.stringify({
      decision: 'block',
      reason,
    }),
  };
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

/** Entry point. Exported for testing. */
export async function run(stdin: string): Promise<{ exit: number; stdout?: string }> {
  const cfg = readConfig();

  let input: ClaudeCodeHookInput;
  try {
    input = JSON.parse(stdin) as ClaudeCodeHookInput;
  } catch {
    if (cfg.debug) console.error('[gatekeeper-hook] bad stdin JSON; passing through');
    return { exit: 0 };
  }

  const mapped = mapClaudeCodeTool(input.tool_name, input.tool_input ?? {});
  if (!mapped) {
    if (cfg.debug)
      console.error(`[gatekeeper-hook] tool ${input.tool_name} not gated; passing through`);
    return { exit: 0 };
  }

  let evaluation: GatekeeperEvaluationResponse;
  try {
    evaluation = await evaluate(cfg.baseUrl, mapped.tool, mapped.args, {
      agentName: cfg.agentName,
      agentRole: cfg.agentRole,
      timeoutMs: cfg.timeoutMs,
      sessionId: input.session_id,
      runId: cfg.runId,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (cfg.failClosed) {
      if (cfg.debug) console.error(`[gatekeeper-hook] fail-closed: ${msg}`);
      return {
        exit: 0,
        stdout: JSON.stringify({
          decision: 'block',
          reason: `Gatekeeper unreachable (${msg}) and GATEKEEPER_FAIL_CLOSED is set.`,
        }),
      };
    }
    if (cfg.debug) console.error(`[gatekeeper-hook] fail-open: ${msg}`);
    return { exit: 0 };
  }

  if (cfg.debug) {
    console.error(
      `[gatekeeper-hook] ${input.tool_name} -> ${mapped.tool}: ${evaluation.decision} (${evaluation.reasonCode ?? '-'})`
    );
  }

  let heldAction: GatekeeperEvaluationResponse | undefined;
  if (evaluation.decision === 'approve' && mapped.executableOnApproval !== false) {
    try {
      heldAction = await registerHeldAction(cfg.baseUrl, mapped.tool, mapped.args, {
        agentName: cfg.agentName,
        agentRole: cfg.agentRole,
        timeoutMs: cfg.timeoutMs,
        sessionId: input.session_id,
        runId: cfg.runId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        exit: 0,
        stdout: JSON.stringify({
          decision: 'block',
          reason: `Gatekeeper required approval but could not create the executable hold (${msg}). The action was not executed.`,
        }),
      };
    }
  }

  return buildHookResponse(evaluation, mapped, heldAction);
}

// CLI entry point — only run when executed directly, not when imported by tests.
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('hook.ts') ||
  process.argv[1]?.endsWith('hook.js');

if (isMain) {
  readStdin()
    .then(run)
    .then(({ exit, stdout }) => {
      if (stdout) process.stdout.write(stdout);
      process.exit(exit);
    })
    .catch((err) => {
      console.error(`[gatekeeper-hook] fatal: ${err instanceof Error ? err.message : String(err)}`);
      // Fatal errors fail open by default — don't block the user's session.
      process.exit(readConfig().failClosed ? 1 : 0);
    });
}
