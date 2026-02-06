# Approval Workflow Guide

This guide explains how Gatekeeper's approval system works and how to configure it for your workflow.

## Overview

When a policy returns `decision: approve`, Gatekeeper pauses execution and waits for human approval. This creates a "human-in-the-loop" checkpoint for sensitive operations.

```
Agent Request → Policy Evaluation → APPROVE → Wait for Human → Execute (or Deny)
```

## Approval States

Each approval request moves through these states:

| State | Description |
|-------|-------------|
| `pending` | Waiting for human action |
| `approved` | Human clicked approve, tool executed |
| `denied` | Human clicked deny, request rejected |
| `expired` | Time limit exceeded, no action taken |

Once an approval leaves `pending`, it cannot be used again (single-use enforcement).
Expired approvals default to deny and are logged as such.

## How Approval Links Work

When a request requires approval, Gatekeeper generates two signed URLs:

```
http://127.0.0.1:3847/approve/{approval-id}?sig={signature}&exp={expiry}
http://127.0.0.1:3847/deny/{approval-id}?sig={signature}&exp={expiry}
```

For chat/UI approvals, you can also call:

```
POST http://127.0.0.1:3847/approvals/{approval-id}/approve
POST http://127.0.0.1:3847/approvals/{approval-id}/deny
```

These POST endpoints accept either:
- A trusted header (`Authorization: Bearer $GATEKEEPER_SECRET` or `X-Gatekeeper-Secret`)
- Or the same signed fields in the JSON body: `{"sig":"...","exp":"..."}`

### Security Properties

- **HMAC-signed** - The signature covers the tool name, arguments, request ID, expiry, and action. This prevents tampering.
- **Single-use** - Once clicked, the link cannot be reused. Prevents replay attacks.
- **Time-limited** - Links expire after 1 hour (configurable). Prevents stale approvals.
- **Action-specific** - The approve and deny links have different signatures. You can't use an approve signature to deny.

### What Gets Signed

The signature is computed over:
```
toolName:canonicalArgs:requestId:expiresAt:action
```

This means:
- You can't change what tool is being approved
- You can't change the arguments
- You can't extend the expiry
- You can't switch between approve/deny

---

## Approval Providers

Gatekeeper supports multiple ways to deliver approval requests.

### Local Console (Default)

Prints approval links to the console. Good for development.

```bash
# No configuration needed - this is the default
docker-compose up
```

When an approval is needed, you'll see:
```
Approval required for shell.exec
  Agent: my-agent
  Command: rm -rf ./temp/*

  Approve: http://127.0.0.1:3847/approve/abc123?sig=...&exp=...
  Deny:    http://127.0.0.1:3847/deny/abc123?sig=...&exp=...
```

Click the link or use curl to approve/deny.

### Slack Integration

Sends approval requests to a Slack channel with interactive buttons.

```yaml
# Environment variables
APPROVAL_PROVIDER=slack
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
SLACK_CHANNEL=#agent-approvals
```

The Slack message includes:
- Tool name and agent
- Formatted arguments
- Approve/Deny buttons
- Expiry timestamp

### Demo Mode (Programmatic)

For testing, demo mode includes approval URLs in the API response:

```bash
DEMO_MODE=true docker-compose up
```

API response includes:
```json
{
  "decision": "approve",
  "approvalId": "abc123",
  "approvalRequest": {
    "approvalId": "abc123",
    "expiresAt": "2024-01-15T11:00:00.000Z",
    "reasonCode": "POLICY_APPROVAL_REQUIRED",
    "humanExplanation": "Policy requires human approval before running \"shell.exec\".",
    "approveUrl": "http://127.0.0.1:3847/approve/abc123?sig=...&exp=...",
    "denyUrl": "http://127.0.0.1:3847/deny/abc123?sig=...&exp=..."
  }
}
```

Your test can then call the approveUrl to complete the flow.

---

## Approval Flow Examples

### Example 1: Agent Requests Shell Command

**Step 1: Agent makes request**
```bash
curl -X POST http://127.0.0.1:3847/tool/shell.exec \
  -H "Content-Type: application/json" \
  -d '{
    "requestId": "req-001",
    "actor": {"type": "agent", "name": "my-agent", "role": "openclaw"},
    "args": {"command": "ls -la /tmp"}
  }'
```

**Step 2: Gatekeeper returns approval pending**
```json
{
  "decision": "approve",
  "requestId": "req-001",
  "approvalId": "550e8400-e29b-41d4-a716-446655440000",
  "expiresAt": "2024-01-15T11:00:00.000Z",
  "reasonCode": "POLICY_APPROVAL_REQUIRED",
  "humanExplanation": "Policy requires human approval before running \"shell.exec\".",
  "message": "Approval required. Check local for approval links.",
  "approvalRequest": {
    "approvalId": "550e8400-e29b-41d4-a716-446655440000",
    "expiresAt": "2024-01-15T11:00:00.000Z",
    "reasonCode": "POLICY_APPROVAL_REQUIRED",
    "humanExplanation": "Policy requires human approval before running \"shell.exec\"."
  }
}
```

**Step 3: Human approves**
```bash
curl -X POST http://127.0.0.1:3847/approvals/550e8400-e29b-41d4-a716-446655440000/approve \
  -H "Authorization: Bearer $GATEKEEPER_SECRET"
```

**Step 4: Tool executes and returns result**
```json
{
  "success": true,
  "approvalId": "550e8400-e29b-41d4-a716-446655440000",
  "result": {
    "exitCode": 0,
    "stdout": "total 24\ndrwxr-xr-x  3 user  wheel   96 Jan 15 10:00 .\n..."
  }
}
```

### Example 2: Chat/UI Approval (No Signed URL)

If your chat UI holds the Gatekeeper secret, it can approve directly:

```bash
curl -X POST http://127.0.0.1:3847/approvals/550e8400-e29b-41d4-a716-446655440000/deny \
  -H "X-Gatekeeper-Secret: $GATEKEEPER_SECRET"
```

---

## Troubleshooting

### "Approval not found" (404)

The approval ID doesn't exist. Possible causes:
- Typo in the approval ID
- Gatekeeper restarted and lost in-memory state
- Approval file was deleted

### "Approval has expired" (410)

The 1-hour time limit was exceeded. Request a new approval.

### "Approval already approved/denied" (409)

The link was already clicked. Approvals are single-use. If you need to re-execute, the agent must make a new request.

### "Invalid signature" (403)

The signature doesn't match. Possible causes:
- URL was modified
- Using wrong action (approve URL for deny)
- Gatekeeper secret changed

### "Missing signature or expiry" (400)

The URL is incomplete. Ensure both `sig` and `exp` query parameters are present.

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `APPROVAL_PROVIDER` | `local` | Provider: `local`, `slack` |
| `APPROVAL_EXPIRY_MS` | `3600000` | Approval timeout (1 hour) |
| `SLACK_WEBHOOK_URL` | - | Slack webhook for notifications |
| `SLACK_CHANNEL` | - | Slack channel name |

### Approval Storage

Approvals are stored in `data/approvals/` as JSON files:

```
data/approvals/
  550e8400-e29b-41d4-a716-446655440000.json
  ...
```

Each file contains:
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "pending",
  "toolName": "shell.exec",
  "args": {"command": "ls -la"},
  "canonicalArgs": "{\"command\":\"ls -la\"}",
  "actor": {"type": "agent", "name": "my-agent", "role": "openclaw"},
  "requestId": "req-001",
  "createdAt": "2024-01-15T10:00:00.000Z",
  "expiresAt": "2024-01-15T11:00:00.000Z"
}
```

---

## Security Considerations

### Why HMAC Signing?

Without signatures, anyone with network access could:
- Approve requests they shouldn't
- Forge approval IDs
- Modify request parameters

The HMAC signature proves the URL was generated by Gatekeeper with the exact parameters shown.

### Why Single-Use?

Without single-use enforcement:
- An attacker could replay an old approval
- The same approval could execute multiple times
- Audit logs wouldn't accurately reflect actions

### Why Time-Limited?

Without expiry:
- Old approvals could be used indefinitely
- Context may have changed since the request
- Forgotten approvals remain active forever

---

## Next Steps

- [Policy Writing Guide](./POLICY_GUIDE.md) - Configure what needs approval
- [Audit Log Reference](./AUDIT_LOGS.md) - Track approval decisions
- [Threat Model](../THREAT_MODEL.md) - Security assumptions
