# Runestone Gatekeeper — MCP Server

An [MCP](https://modelcontextprotocol.io) server that lets any MCP client (Claude
Desktop, Claude Code, Cursor, …) run real tool calls — shell, file writes, HTTP,
or any Gatekeeper tool — **only through [Runestone Gatekeeper](https://github.com/Runestone-Labs/gatekeeper)**.
Every call is policy-checked, may require human approval, and is audited. The
model never touches your systems directly; Gatekeeper sits in front.

```
MCP client (LLM)  ──tools/call──▶  gatekeeper-mcp  ──policy-gated──▶  Gatekeeper  ──▶  shell / files / HTTP
```

## Requirements

A running Gatekeeper server (see the repo root). This package is just the MCP
front door; it does nothing on its own.

## Install / configure

It runs over stdio. Add it to your MCP client config, e.g. Claude Desktop
(`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "gatekeeper": {
      "command": "npx",
      "args": ["-y", "@runestone-labs/gatekeeper-mcp"],
      "env": {
        "GATEKEEPER_URL": "http://127.0.0.1:3847",
        "GATEKEEPER_ROLE": "openclaw"
      }
    }
  }
}
```

| Env | Required | Default | Meaning |
|-----|----------|---------|---------|
| `GATEKEEPER_ROLE` | **yes** | — | The policy role this server presents to Gatekeeper for every call. |
| `GATEKEEPER_URL` | no | `http://127.0.0.1:3847` | Gatekeeper base URL. |
| `GATEKEEPER_AGENT_NAME` | no | `mcp-client` | Name recorded in audit logs. |

## Tools

| Tool | Gatekeeper tool | Use |
|------|-----------------|-----|
| `shell_exec` | `shell.exec` | Run a shell command. |
| `files_write` | `files.write` | Write a file. |
| `http_request` | `http.request` | HTTP GET/POST (egress-policed). |
| `gatekeeper_call` | *(any)* | Generic escape hatch — call any Gatekeeper tool (e.g. `memory.query`) by name. |
| `gatekeeper_health` | — | Check the Gatekeeper server is reachable. |

Every gated call returns one of:
- **allow** → the tool output.
- **deny** → an *error* result explaining why (the call did not run).
- **approve** → an *error* result saying a human must approve it in Gatekeeper; the call did **not** run.

## Security model

This server is a policy boundary, so it is deliberately strict:

- **Identity is pinned server-side.** Role comes from `GATEKEEPER_ROLE`; origin
  is fixed to `model_inferred` and taint to `mcp_client`. The MCP client cannot
  set or override actor / role / origin / taint / capability tokens via tool
  arguments — there is no code path from a tool argument to any of those.
- **Fail closed.** A deny, a pending approval, or *any* malformed/unexpected
  Gatekeeper response is surfaced as an error — never as a successful result.
- **No endpoint traversal.** Generic tool names are validated as strict dotted
  identifiers; `../`, slashes, and the like are rejected before any request.
- **No leakage.** The Gatekeeper URL and anything resembling a credential are
  scrubbed from error messages before they reach the client.

These invariants are covered by an adversarial test suite (`src/*.test.ts`).

## Distribution

Published to npm as `@runestone-labs/gatekeeper-mcp` and listed on the MCP
Registry as `io.github.runestone-labs/gatekeeper` (see `server.json`). The MCP
Registry is in preview.

## License

Apache-2.0
