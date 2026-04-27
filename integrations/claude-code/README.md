# `@runestone-labs/gatekeeper-claude-code`

Claude Code PreToolUse hook that routes `Bash`, `Write`, `Edit`, and `WebFetch`
tool calls through a running Runestone Gatekeeper server before Claude Code
executes them.

The hook adds a sensitive-resource boundary to Claude Code: it catches the
"helpful overreach" failure mode where an agent debugging one thing escalates
into touching credential stores, SSH keys, cloud creds, browser profiles, or
other local secrets — without changing how Claude Code feels for normal work.

## Why this exists

A coding agent debugging a Puppeteer / Chromium "Safe Storage" prompt on macOS
first applied a normal flag-based fix:

```ts
const browser = await puppeteer.launch({
  headless: 'shell',
  args: [
    '--password-store=basic',
    '--use-mock-keychain',
    '--user-data-dir=/tmp/runestone-headless-profile',
    '--no-first-run',
    '--no-default-browser-check',
  ],
});
```

When the prompt persisted, the agent pivoted to:

```bash
security find-generic-password -s "Chromium Safe Storage"
```

…and was about to run:

```bash
security delete-generic-password -s "Chromium Safe Storage"
```

Neither command was malicious. The agent was being helpful. That is the
failure mode Gatekeeper's Sensitive Boundary rule pack catches.

With this hook installed, both commands are intercepted by Claude Code before
execution. The first returns a `require_approval` block with a safer
alternative (use a throwaway profile). The second is denied outright.

## Install

You need:

- A running Gatekeeper server on `http://127.0.0.1:3847` (default). See the
  [main README](../../README.md) for boot instructions.
- Node.js ≥ 18 (the hook uses native `fetch`).
- Claude Code installed.

Then:

```bash
npm install -g @runestone-labs/gatekeeper-claude-code
```

This installs the `gatekeeper-claude-code-hook` binary on your `$PATH`.

## Wire it into Claude Code

Merge the contents of `settings.example.json` into your
`~/.claude/settings.json` (or the project-local `.claude/settings.json`):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Write|Edit|WebFetch",
        "hooks": [
          { "type": "command", "command": "gatekeeper-claude-code-hook" }
        ]
      }
    ]
  }
}
```

Restart any running Claude Code sessions. New tool calls will route through
Gatekeeper.

## What the hook does

1. Reads Claude Code's PreToolUse JSON envelope from stdin.
2. Maps the tool to its Gatekeeper equivalent:

   | Claude Code tool | Gatekeeper tool      | Notes                                                     |
   | ---------------- | -------------------- | --------------------------------------------------------- |
   | `Bash`           | `shell.exec`         | Forwards `command`, `cwd`, `timeoutMs`/`timeout`.         |
   | `Write`          | `files.write`        | `file_path` → `path`, `content` → `content`.              |
   | `Edit`           | `files.write`        | Path-based check; `new_string` is sent as `content`.      |
   | `WebFetch`       | `http.request`       | Sent as `GET`.                                            |
   | Read / Glob / Grep / NotebookEdit / MCP tools | (skipped) | Not gated in v0.4. Path-based read gating arrives with the planned `files.read` tool. |

3. POSTs `dryRun: true` to `POST /tool/:toolName` so Gatekeeper evaluates the
   request *without* trying to execute it. Claude Code remains the only
   executor.
4. Translates the decision back into Claude Code's hook output:
   - **allow** → exit 0, no output. Claude Code runs the tool normally.
   - **deny** or **require_approval** → emits
     `{ "decision": "block", "reason": "..." }` to stdout. Claude Code surfaces
     the reason to the model and lets it pivot.

## Failure mode

If the Gatekeeper server is unreachable, the hook **fails open** by default
(exit 0, no message) so an unrunning server doesn't break your day.

Set `GATEKEEPER_FAIL_CLOSED=1` to flip to **fail closed**: every gated tool
call is blocked until the server returns.

## Configuration (env vars)

| Variable                  | Default                  | Purpose                                                          |
| ------------------------- | ------------------------ | ---------------------------------------------------------------- |
| `GATEKEEPER_BASE_URL`     | `http://127.0.0.1:3847`  | Base URL of the Gatekeeper server.                               |
| `GATEKEEPER_AGENT_NAME`   | `claude-code`            | Logged in `actor.name` for audit trails.                         |
| `GATEKEEPER_AGENT_ROLE`   | `claude-code`            | Logged in `actor.role`; matched against `principals` in policy.  |
| `GATEKEEPER_TIMEOUT_MS`   | `2000`                   | Per-call HTTP timeout. Tune lower if it adds noticeable latency. |
| `GATEKEEPER_FAIL_CLOSED`  | unset (fail-open)        | `1` or `true` to block on server errors instead of passing through. |
| `GATEKEEPER_DEBUG`        | unset                    | `1` to log every decision to stderr.                             |

## Demo

Run a fresh Claude Code session with the hook installed and ask it to inspect
your Keychain. You should see the model receive a Gatekeeper block message
and respond with a different approach.

The end-to-end fixture used as the canonical demo lives at
[`examples/sensitive-boundaries/keychain-scope-creep.json`](../../examples/sensitive-boundaries/keychain-scope-creep.json).

## Testing

```bash
npm test
```

The tests spin up an in-process mock Gatekeeper server, send the hook
synthetic Claude Code envelopes (including the Puppeteer escalation), and
assert the hook output. No real Gatekeeper server is required.
