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
 *      Gatekeeper evaluates policy without trying to execute (Claude Code
 *      does the actual execution itself, downstream of the hook).
 *   4. Translates the Gatekeeper decision into Claude Code's hook output
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
 *   GATEKEEPER_DEBUG          "1" to log decisions to stderr
 */

import { randomUUID } from 'node:crypto';

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
}

interface MappedRequest {
  tool: string;
  args: Record<string, unknown>;
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
  failClosed: boolean;
  timeoutMs: number;
  debug: boolean;
} {
  return {
    baseUrl: process.env.GATEKEEPER_BASE_URL ?? 'http://127.0.0.1:3847',
    agentName: process.env.GATEKEEPER_AGENT_NAME ?? 'claude-code',
    agentRole: process.env.GATEKEEPER_AGENT_ROLE ?? 'claude-code',
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
  opts: { agentName: string; agentRole: string; timeoutMs: number; sessionId?: string }
): Promise<GatekeeperEvaluationResponse> {
  const body = {
    requestId: randomUUID(),
    actor: { type: 'agent' as const, name: opts.agentName, role: opts.agentRole },
    args,
    context: opts.sessionId ? { conversationId: opts.sessionId } : undefined,
    origin: 'model_inferred' as const,
    dryRun: true,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/tool/${encodeURIComponent(toolName)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Gatekeeper returned HTTP ${res.status}`);
    }
    return (await res.json()) as GatekeeperEvaluationResponse;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Translate a Gatekeeper evaluation into Claude Code's hook output. Allow
 * returns null (exit 0). Deny / approve return a JSON block that Claude Code
 * surfaces back to the model so it can pivot.
 */
export function buildHookResponse(
  evaluation: GatekeeperEvaluationResponse,
  mapped: MappedRequest
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
  lines.push(
    `Tool: ${mapped.tool}. To proceed, the user should run this manually outside Claude Code, or update Gatekeeper's sensitive_boundaries policy.`
  );

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

  return buildHookResponse(evaluation, mapped);
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
