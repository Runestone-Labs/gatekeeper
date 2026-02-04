# Runestone Gatekeeper OpenClaw Plugin

An [OpenClaw](https://openclaw.ai) plugin that routes tool execution through [Runestone Gatekeeper](https://github.com/Runestone-Labs/gatekeeper) for policy enforcement and approval workflows.

## Why Use This?

OpenClaw can execute shell commands, write files, and make HTTP requests. Without guardrails, this is risky:

- **Accidental damage**: Agent runs destructive commands
- **Prompt injection**: Malicious content tricks agent into dangerous actions
- **Data exfiltration**: Agent sends secrets to external services
- **SSRF attacks**: Agent accesses internal services

This plugin routes all tool calls through Gatekeeper, which:

- **Blocks** dangerous operations immediately
- **Requires approval** for sensitive operations
- **Logs everything** for audit and compliance

## Installation

### 1. Start Gatekeeper

```bash
# Clone and run Gatekeeper
git clone https://github.com/Runestone-Labs/gatekeeper.git
cd gatekeeper
npm install
npm run dev
```

### 2. Install the Plugin

```bash
# Copy plugin to OpenClaw extensions directory
cp -r integrations/openclaw ~/.openclaw/extensions/gatekeeper
```

### 3. Configure OpenClaw

Add to your `~/.openclaw/openclaw.json`:

```json
{
  "env": {
    "GATEKEEPER_URL": "http://localhost:3847"
  },
  "tools": {
    "deny": ["exec", "write", "bash"],
    "alsoAllow": ["gk_exec", "gk_write", "gk_http"]
  },
  "plugins": {
    "entries": {
      "gatekeeper": { "enabled": true }
    }
  }
}
```

**Important:** The `tools.deny` setting blocks native tools from being sent to the model. This ensures all operations go through Gatekeeper for policy enforcement.

### 4. Restart OpenClaw

```bash
openclaw gateway restart
```

## Why Block Native Tools?

Without blocking native tools, the model may:

1. Choose native `exec` over `gk_exec` for commands
2. Pre-filter "dangerous" requests before Gatekeeper can evaluate them
3. Bypass Gatekeeper entirely for some operations

By denying native tools, the model has no choice but to use the Gatekeeper-wrapped versions. This ensures:

- **All operations are policy-checked**
- **All operations are logged** for audit
- **Consistent behavior** across different models

## Usage

Once installed, the plugin provides these tools:

| Tool | Description |
|------|-------------|
| `gk_exec` | Execute a shell command |
| `gk_write` | Write content to a file |
| `gk_http` | Make an HTTP request |

### Examples

```
# Execute a shell command
gk_exec command="ls -la"

# Write a file
gk_write path="/tmp/output.txt" content="Hello!"

# Make an HTTP request
gk_http url="https://api.example.com/data" method="GET"
```

## Tool Reference

### gk_exec

Execute a shell command.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | string | Yes | Shell command to execute |
| `cwd` | string | No | Working directory |

### gk_write

Write a file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Absolute path to write |
| `content` | string | Yes | Content to write |
| `encoding` | string | No | `utf8` (default) or `base64` |

### gk_http

Make an HTTP request.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | Yes | URL to request |
| `method` | string | Yes | HTTP method |
| `headers` | object | No | Request headers |
| `body` | string | No | Request body |

## Handling Approvals

When Gatekeeper requires human approval, the tool returns:

```json
{
  "content": [{
    "type": "text",
    "text": "Approval required (expires: ...). Ask user to approve, then retry. Approval ID: abc-123"
  }]
}
```

The agent should:
1. Inform the user that approval is needed
2. Wait for the user to approve (via Gatekeeper console, Slack, etc.)
3. Retry the same command after approval

## Customizing Policy

Edit `policy.yaml` in your Gatekeeper installation to customize what's allowed, denied, or requires approval.

See [Gatekeeper documentation](https://github.com/Runestone-Labs/gatekeeper#policy-configuration) for policy options.

## Configuration Options

You can configure the plugin via `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "gatekeeper": {
        "enabled": true,
        "config": {
          "gatekeeperUrl": "http://localhost:3847"
        }
      }
    }
  }
}
```

Or via environment variable:

```bash
export GATEKEEPER_URL=http://localhost:3847
```

## License

Apache-2.0
