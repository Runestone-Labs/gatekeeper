# Runestone Gatekeeper OpenClaw Skill

An [OpenClaw](https://openclaw.ai) skill that routes tool execution through [Runestone Gatekeeper](https://github.com/Runestone-Labs/gatekeeper) for policy enforcement and approval workflows.

## Why Use This?

OpenClaw can execute shell commands, write files, and make HTTP requests. Without guardrails, this is risky:

- **Accidental damage**: Agent runs destructive commands
- **Prompt injection**: Malicious content tricks agent into dangerous actions
- **Data exfiltration**: Agent sends secrets to external services
- **SSRF attacks**: Agent accesses internal services

This skill routes all tool calls through Gatekeeper, which:

- **Blocks** dangerous operations immediately
- **Requires approval** for sensitive operations
- **Logs everything** for audit and compliance

## Installation

### 1. Start Gatekeeper

```bash
# Clone and run Gatekeeper
git clone https://github.com/Runestone-Labs/gatekeeper.git
cd gatekeeper
docker-compose up
```

### 2. Install the Skill

```bash
# Copy skill to OpenClaw skills directory
cp -r integrations/openclaw ~/.openclaw/skills/gatekeeper
```

### 3. Configure

Set the Gatekeeper URL (default is localhost:3847):

```bash
export GATEKEEPER_URL=http://localhost:3847
```

## Usage

Once installed, use the gatekeeper-prefixed tools instead of OpenClaw's built-in tools:

| Instead of | Use |
|------------|-----|
| `exec` / `bash` | `gk_exec` |
| `write` | `gk_write` |
| `web_fetch` | `gk_http` |

### Examples

```
# Execute a shell command (will be policy-checked)
gk_exec command="ls -la"

# Write a file (sensitive paths require approval)
gk_write path="/tmp/output.txt" content="Hello!"

# Make an HTTP request (SSRF-protected)
gk_http url="https://api.example.com/data" method="GET"
```

## Tool Reference

### gk_exec

Execute a shell command.

| Parameter | Type | Description |
|-----------|------|-------------|
| `command` | string | Shell command to execute |
| `cwd` | string? | Working directory |

### gk_write

Write a file.

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | Absolute path to write |
| `content` | string | Content to write |
| `encoding` | string? | `utf8` (default) or `base64` |

### gk_http

Make an HTTP request.

| Parameter | Type | Description |
|-----------|------|-------------|
| `url` | string | URL to request |
| `method` | string | HTTP method |
| `headers` | object? | Request headers |
| `body` | string? | Request body |

## Handling Approvals

When Gatekeeper requires human approval, the tool returns:

```json
{
  "pending": true,
  "message": "Approval required (expires: ...). Ask user to approve, then retry.",
  "approvalId": "abc-123"
}
```

The agent should:
1. Inform the user that approval is needed
2. Wait for the user to approve (via Gatekeeper console, Slack, etc.)
3. Retry the same command after approval

## Customizing Policy

Edit `policy.yaml` in your Gatekeeper installation to customize what's allowed, denied, or requires approval.

See [Gatekeeper documentation](https://github.com/Runestone-Labs/gatekeeper#policy-configuration) for policy options.

## License

Apache-2.0
