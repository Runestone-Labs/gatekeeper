# Policy Writing Guide

This guide explains how to write and customize Gatekeeper policies to control what actions AI agents can take.

## Overview

A Gatekeeper policy is a YAML file that defines rules for each tool. The policy file is loaded at startup and determines whether requests are:

- **Allowed** - Executed immediately
- **Approved** - Requires human approval before execution
- **Denied** - Blocked entirely

## Policy Structure

```yaml
tools:
  tool.name:
    decision: allow | approve | deny
    # tool-specific constraints...
```

Each tool has a `decision` and optional constraints. Unknown tools are denied by default.

You can also add global deny patterns and compose policies:

```yaml
extends:
  - ./base-policy.yaml

principals_file: ./principals.yaml

global_deny_patterns:
  - "token=.+"
  - "BEGIN\\s+PRIVATE\\s+KEY"
```

`extends` merges base policies before applying the current file. `principals_file` loads role policies from a separate YAML file.

---

## Decision Types

### `allow` - Execute Immediately

Use for low-risk operations where you trust the agent to make good decisions.

```yaml
tools:
  http.request:
    decision: allow
```

The tool executes immediately and returns the result. No human in the loop.

### `approve` - Require Human Approval

Use for sensitive operations that need human oversight.

```yaml
tools:
  shell.exec:
    decision: approve
```

The request is paused and a notification is sent (via Slack, console, etc.). The agent receives an approval ID and must wait. Once a human approves, the agent can proceed.

### `deny` - Block Entirely

Use to completely block certain tools or when constraints are violated.

```yaml
tools:
  dangerous.tool:
    decision: deny
```

The request is rejected immediately with a reason.

---

## Tool-Specific Options

### `shell.exec` - Shell Command Execution

Controls what shell commands agents can run.

```yaml
tools:
  shell.exec:
    decision: approve

    # Patterns that trigger immediate denial (regex)
    deny_patterns:
      - "rm -rf"
      - "sudo"
      - "curl.*\\|.*sh"

    # Allowed working directories (prefix match)
    allowed_cwd_prefixes:
      - "/tmp/"
      - "./data/"

    # Allowed commands (only simple commands permitted when set)
    allowed_commands:
      - "ls"
      - "git"

    # Optional sandbox prefix (prepended to every command)
    # sandbox_command_prefix:
    #   - "firejail"
    #   - "--noprofile"
    #   - "--"

    # Optional user/group to run as (requires privileges)
    # run_as_uid: 1000
    # run_as_gid: 1000

    # Optional environment allowlist and overrides
    # env_allowlist:
    #   - "PATH"
    #   - "HOME"
    # env_overrides:
    #   NODE_ENV: "production"

    # Limits
    max_output_bytes: 1048576   # 1MB
    max_timeout_ms: 30000       # 30 seconds
```

| Option | Type | Description |
|--------|------|-------------|
| `deny_patterns` | string[] | Regex patterns that cause immediate denial |
| `allowed_commands` | string[] | Allowlist of executable names (simple commands only) |
| `allowed_cwd_prefixes` | string[] | Allowed working directories (if specified) |
| `sandbox_command_prefix` | string[] | Prefix command for sandbox wrappers |
| `run_as_uid` | number | Run commands as a specific UID |
| `run_as_gid` | number | Run commands as a specific GID |
| `env_allowlist` | string[] | Environment variables to pass through |
| `env_overrides` | object | Key/value overrides for env |
| `max_output_bytes` | number | Maximum stdout/stderr size |
| `max_timeout_ms` | number | Maximum execution time |

### `files.write` - File Writing

Controls where and what agents can write to disk.

```yaml
tools:
  files.write:
    decision: approve

    # Allowed paths (prefix match)
    allowed_paths:
      - "/tmp/"
      - "./data/"
      - "./output/"

    # Blocked file extensions
    deny_extensions:
      - ".env"
      - ".pem"
      - ".key"

    # Limits
    max_size_bytes: 10485760    # 10MB
```

| Option | Type | Description |
|--------|------|-------------|
| `allowed_paths` | string[] | Path prefixes where writing is allowed |
| `deny_extensions` | string[] | File extensions that are blocked |
| `max_size_bytes` | number | Maximum file size |

### `http.request` - HTTP Requests

Controls what HTTP requests agents can make.

```yaml
tools:
  http.request:
    decision: allow

    # Allowed HTTP methods
    allowed_methods:
      - GET
      - POST

    # Blocked domains
    deny_domains:
      - pastebin.com
      - evil.com

    # Allowed domains (exact or suffix match)
    # allowed_domains:
    #   - "api.example.com"
    #   - ".example.org"

    # SSRF protection: blocked IP ranges (CIDR notation)
    deny_ip_ranges:
      - "127.0.0.0/8"      # Loopback
      - "10.0.0.0/8"       # Private Class A
      - "169.254.0.0/16"   # Cloud metadata

    # Limits
    timeout_ms: 30000
    max_body_bytes: 1048576
    max_redirects: 3
```

| Option | Type | Description |
|--------|------|-------------|
| `allowed_methods` | string[] | HTTP methods that are allowed |
| `allowed_domains` | string[] | Allowed domains (exact or suffix match) |
| `deny_domains` | string[] | Domains that are blocked |
| `deny_ip_ranges` | string[] | IP ranges blocked (SSRF protection) |
| `timeout_ms` | number | Request timeout |
| `max_body_bytes` | number | Maximum response body size |
| `max_redirects` | number | Maximum number of redirects |

---

## Writing Regex Patterns

The `deny_patterns` option uses JavaScript regex syntax. Patterns are matched against the canonicalized (JSON-encoded) request arguments.

### Common Patterns

```yaml
deny_patterns:
  # Exact substring match
  - "rm -rf"

  # Match sudo anywhere
  - "sudo"

  # Pipe to shell (curl | sh, wget | bash, etc.)
  - "curl.*\\|.*sh"
  - "wget.*\\|.*sh"

  # Write to device files
  - "> /dev/"

  # Dangerous permissions
  - "chmod 777"
  - "chmod \\+s"

  # Environment variable extraction
  - "\\$\\{.*\\}"
  - "printenv"
```

### Tips

1. **Escape backslashes** - YAML requires `\\` for a literal `\`
2. **Test patterns** - Use a regex tester with your expected inputs
3. **Match canonicalized args** - Patterns match against JSON like `{"command":"ls -la"}`
4. **Case insensitive** - Patterns are matched case-insensitively

---

## Policy Recipes

### Development Mode (Permissive)

For local development where you trust the agent:

```yaml
tools:
  shell.exec:
    decision: allow
    deny_patterns:
      - "rm -rf /"
      - "sudo"
    max_timeout_ms: 60000

  files.write:
    decision: allow
    deny_extensions:
      - ".env"

  http.request:
    decision: allow
    deny_ip_ranges:
      - "169.254.0.0/16"  # Block cloud metadata only
```

### Production Mode (Approval-Heavy)

For production where most actions need review:

```yaml
tools:
  shell.exec:
    decision: approve
    deny_patterns:
      - "rm -rf"
      - "sudo"
      - "curl.*\\|.*sh"
      - "> /dev/"
    allowed_cwd_prefixes:
      - "/app/workspace/"
    max_timeout_ms: 30000

  files.write:
    decision: approve
    allowed_paths:
      - "/app/workspace/"
    deny_extensions:
      - ".env"
      - ".pem"
      - ".key"
    max_size_bytes: 5242880

  http.request:
    decision: approve
    allowed_methods:
      - GET
    deny_domains:
      - pastebin.com
    deny_ip_ranges:
      - "127.0.0.0/8"
      - "10.0.0.0/8"
      - "172.16.0.0/12"
      - "192.168.0.0/16"
      - "169.254.0.0/16"
```

### Locked Down Mode (Restrictive)

For high-security environments:

```yaml
tools:
  shell.exec:
    decision: deny

  files.write:
    decision: approve
    allowed_paths:
      - "/app/output/"
    deny_extensions:
      - ".env"
      - ".pem"
      - ".key"
      - ".sh"
      - ".bash"
    max_size_bytes: 1048576

  http.request:
    decision: deny
```

---

## Testing Your Policy

### Manual Testing

Start Gatekeeper with your policy:

```bash
docker run -v ./my-policy.yaml:/app/policy.yaml:ro \
  -p 3847:3847 \
  runestone-gatekeeper
```

Test a request:

```bash
# Test shell.exec
curl -X POST http://127.0.0.1:3847/tool/shell.exec \
  -H "Content-Type: application/json" \
  -d '{
    "requestId": "test-1",
    "actor": {"type": "agent", "name": "test", "role": "openclaw"},
    "args": {"command": "ls -la"}
  }'

# Expected responses:
# - decision: "allow" -> executes immediately
# - decision: "approve" -> returns approvalId
# - decision: "deny" -> returns reason
```

### Using the Live Test Script

```bash
GATEKEEPER_URL=http://127.0.0.1:3847 npx tsx integrations/live-test.ts
```

---

## Evaluation Order

When a request arrives, Gatekeeper evaluates in this order:

1. **Unknown tool check** - If tool isn't in policy, deny
2. **Deny patterns** - If any pattern matches, deny
3. **Tool-specific validation** - Check constraints (paths, methods, etc.)
4. **Return decision** - allow, approve, or deny

Deny patterns are checked first, so a matching pattern will deny even if the base decision is `allow`.

---

## Best Practices

1. **Start restrictive, loosen as needed** - It's easier to grant permissions than revoke them

2. **Use `approve` for new tools** - Until you understand usage patterns

3. **Block dangerous patterns explicitly** - Don't rely on `approve` to catch `rm -rf /`

4. **Limit blast radius** - Use `allowed_paths` and `allowed_cwd_prefixes` to constrain where agents can operate

5. **Log and review** - Check audit logs to understand what agents are doing before loosening policy

6. **Version your policies** - Keep policies in git and track changes

---

## Next Steps

- [Approval Workflow Guide](./APPROVALS.md) - How approvals work
- [Audit Log Reference](./AUDIT_LOGS.md) - Understanding audit logs
- [Threat Model](../THREAT_MODEL.md) - Security assumptions and non-goals
