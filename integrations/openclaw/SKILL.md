---
name: gatekeeper
description: Route tool execution through Runestone Gatekeeper for policy enforcement and approval workflows
homepage: https://github.com/Runestone-Labs/gatekeeper
user-invocable: false
---

# Gatekeeper Integration

This skill provides secure tool execution via [Runestone Gatekeeper](https://github.com/Runestone-Labs/gatekeeper).

Instead of using OpenClaw's built-in tools directly, use these gatekeeper-proxied versions to get:

- **Policy enforcement**: Dangerous operations are blocked
- **Human approval**: Sensitive operations require approval before execution
- **Audit logging**: All decisions are logged for compliance

## Tools

### gk_exec

Execute a shell command through Gatekeeper policy enforcement.

```
gk_exec command="ls -la" cwd="/home/user"
```

- Dangerous commands (e.g., `rm -rf /`) will be **DENIED**
- Sensitive commands may require human **APPROVAL**
- Safe commands execute immediately

### gk_write

Write a file through Gatekeeper policy enforcement.

```
gk_write path="/tmp/output.txt" content="Hello, world!"
```

- Writes to sensitive paths (e.g., `/etc/`) require approval
- Blocked extensions (`.env`, `.key`, `.pem`) are denied
- Safe paths execute immediately

### gk_http

Make HTTP requests through Gatekeeper SSRF protection.

```
gk_http url="https://api.example.com/data" method="GET"
```

- Internal IPs and metadata endpoints are **blocked**
- Dangerous domains can be denied by policy
- External APIs allowed by policy execute immediately

## Setup

1. Start Gatekeeper:
   ```bash
   cd /path/to/gatekeeper
   docker-compose up
   ```

2. Set environment variable:
   ```bash
   export GATEKEEPER_URL=http://localhost:3847
   ```

3. Install this skill:
   ```bash
   cp -r /path/to/gatekeeper/integrations/openclaw ~/.openclaw/skills/gatekeeper
   ```

## Handling Approvals

When a tool returns `pending: true`, the operation requires human approval:

1. The response includes an `approvalId` and expiration time
2. In demo mode, approval URLs are logged to the Gatekeeper console
3. Once approved, retry the same command

Example response when approval is needed:
```json
{
  "pending": true,
  "message": "Approval required (expires: 2024-01-01T12:00:00Z). Ask user to approve, then retry.",
  "approvalId": "abc-123"
}
```
