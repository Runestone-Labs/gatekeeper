# Audit Log Reference

This guide explains Gatekeeper's audit logging system - where logs are stored, what they contain, and how to query them.

## Overview

Every request to Gatekeeper is logged with:
- What was requested (tool, arguments)
- Who requested it (agent, user)
- What decision was made (allow, approve, deny)
- What happened (execution result)
- The policy version in effect

Audit logs are **append-only** - entries are never modified or deleted.

## Log Location

By default, logs are stored in:
```
data/audit/YYYY-MM-DD.jsonl
```

Example:
```
data/audit/
  2024-01-15.jsonl
  2024-01-16.jsonl
  ...
```

Each file contains one JSON object per line (JSONL format).

---

## Log Entry Format

### Field Reference

| Field | Type | Description |
|-------|------|-------------|
| `timestamp` | string | ISO 8601 timestamp |
| `requestId` | string | Unique request identifier (from client) |
| `tool` | string | Tool name (e.g., `shell.exec`) |
| `decision` | string | Decision: `allow`, `approve`, `deny`, `executed`, `approval_consumed` |
| `actor` | object | Who made the request |
| `actor.type` | string | `agent` or `user` |
| `actor.name` | string | Agent/user identifier |
| `actor.role` | string | Required role for policy enforcement |
| `actor.runId` | string | Optional correlation ID for the agent run |
| `argsSummary` | string | JSON of request arguments (secrets redacted) |
| `argsHash` | string | SHA-256 hash of canonicalized args (for replay) |
| `resultSummary` | string | JSON of execution result (if executed) |
| `executionReceipt` | object | Timing + resource info for executions |
| `riskFlags` | string[] | Risk indicators that triggered during evaluation |
| `reasonCode` | string | Machine-readable decision code |
| `humanExplanation` | string | Friendly explanation of the decision |
| `remediation` | string | Suggested remediation (if any) |
| `policyHash` | string | SHA-256 hash of the policy in effect |
| `gatekeeperVersion` | string | Gatekeeper version |
| `approvalId` | string | Approval ID (if approval was involved) |
| `origin` | string | Request origin (v1 envelope) |
| `taint` | string[] | Taint labels (v1 envelope) |
| `contextRefs` | object[] | Context references (v1 envelope) |

### Decision Values

| Decision | Meaning |
|----------|---------|
| `allow` | Policy allowed immediate execution |
| `approve` | Policy requires human approval (pending) |
| `deny` | Policy denied the request |
| `executed` | Tool was executed (after allow or approval) |
| `approval_consumed` | Human clicked approve or deny link |

---

## Example Log Entries

### Allowed Request (immediate execution)

```json
{
  "timestamp": "2024-01-15T10:30:00.000Z",
  "requestId": "req-001",
  "tool": "http.request",
  "decision": "allow",
  "actor": {
    "type": "agent",
    "name": "my-agent",
    "role": "openclaw",
    "runId": "run-123"
  },
  "argsSummary": "{\"url\":\"https://api.example.com/data\",\"method\":\"GET\"}",
  "argsHash": "sha256:9f6c...c1",
  "riskFlags": [],
  "reasonCode": "POLICY_ALLOW",
  "humanExplanation": "Policy allows \"http.request\".",
  "policyHash": "sha256:abc123...",
  "gatekeeperVersion": "0.1.0"
}
```

### Denied Request (pattern match)

```json
{
  "timestamp": "2024-01-15T10:31:00.000Z",
  "requestId": "req-002",
  "tool": "shell.exec",
  "decision": "deny",
  "actor": {
    "type": "agent",
    "name": "my-agent",
    "role": "openclaw"
  },
  "argsSummary": "{\"command\":\"rm -rf /\"}",
  "argsHash": "sha256:7ad1...e4",
  "riskFlags": ["pattern_match:rm -rf"],
  "reasonCode": "TOOL_DENY_PATTERN",
  "humanExplanation": "Request matches a deny pattern configured for this tool.",
  "policyHash": "sha256:abc123...",
  "gatekeeperVersion": "0.1.0"
}
```

### Approval Pending

```json
{
  "timestamp": "2024-01-15T10:32:00.000Z",
  "requestId": "req-003",
  "tool": "shell.exec",
  "decision": "approve",
  "actor": {
    "type": "agent",
    "name": "my-agent",
    "role": "openclaw"
  },
  "argsSummary": "{\"command\":\"ls -la /tmp\"}",
  "argsHash": "sha256:22af...19",
  "riskFlags": ["needs_approval"],
  "reasonCode": "POLICY_APPROVAL_REQUIRED",
  "humanExplanation": "Policy requires human approval before running \"shell.exec\".",
  "policyHash": "sha256:abc123...",
  "gatekeeperVersion": "0.1.0",
  "approvalId": "550e8400-e29b-41d4-a716-446655440000"
}
```

### Approval Consumed (approved)

```json
{
  "timestamp": "2024-01-15T10:35:00.000Z",
  "requestId": "req-003",
  "tool": "shell.exec",
  "decision": "approval_consumed",
  "actor": {
    "type": "agent",
    "name": "my-agent",
    "role": "openclaw"
  },
  "argsSummary": "{\"command\":\"ls -la /tmp\"}",
  "resultSummary": "{\"exitCode\":0,\"stdout\":\"total 24\\n...\"}",
  "riskFlags": ["action:approved"],
  "reasonCode": "APPROVAL_APPROVED",
  "humanExplanation": "The approval request was approved and executed.",
  "policyHash": "sha256:abc123...",
  "gatekeeperVersion": "0.1.0",
  "approvalId": "550e8400-e29b-41d4-a716-446655440000"
}
```

### Execution Result

```json
{
  "timestamp": "2024-01-15T10:35:01.000Z",
  "requestId": "req-003",
  "tool": "shell.exec",
  "decision": "executed",
  "actor": {
    "type": "agent",
    "name": "my-agent",
    "role": "openclaw"
  },
  "argsSummary": "{\"command\":\"ls -la /tmp\"}",
  "resultSummary": "{\"exitCode\":0,\"stdout\":\"total 24\\n...\"}",
  "executionReceipt": {
    "startedAt": "2024-01-15T10:35:00.900Z",
    "completedAt": "2024-01-15T10:35:01.020Z",
    "durationMs": 120
  },
  "riskFlags": [],
  "policyHash": "sha256:abc123...",
  "gatekeeperVersion": "0.1.0",
  "approvalId": "550e8400-e29b-41d4-a716-446655440000"
}
```

---

## Querying Logs with jq

### View Today's Logs

```bash
cat data/audit/$(date +%Y-%m-%d).jsonl | jq '.'
```

### Count Decisions by Type

```bash
cat data/audit/*.jsonl | jq -s 'group_by(.decision) | map({decision: .[0].decision, count: length})'
```

### Find All Denied Requests

```bash
cat data/audit/*.jsonl | jq 'select(.decision == "deny")'
```

### Find Requests by Agent

```bash
cat data/audit/*.jsonl | jq 'select(.actor.name == "my-agent")'
```

### Find Requests by Tool

```bash
cat data/audit/*.jsonl | jq 'select(.tool == "shell.exec")'
```

### Find Requests with Specific Risk Flag

```bash
cat data/audit/*.jsonl | jq 'select(.riskFlags | contains(["pattern_match:rm -rf"]))'
```

### Trace a Request by ID

```bash
cat data/audit/*.jsonl | jq 'select(.requestId == "req-003")'
```

---

## Replay a Decision

To replay a decision deterministically, use the replay script with the original args:

```bash
tsx scripts/replay-policy.ts --log data/audit/2024-01-15.jsonl --request-id req-003 --args /path/to/args.json
```

The script verifies the `argsHash` and re-evaluates policy using the current `policy.yaml`.

### Find All Approvals for a Run

```bash
cat data/audit/*.jsonl | jq 'select(.actor.runId == "run-123" and .decision == "approve")'
```

### Recent Entries (last 10)

```bash
tail -10 data/audit/$(date +%Y-%m-%d).jsonl | jq '.'
```

### Timeline of Events

```bash
cat data/audit/*.jsonl | jq -s 'sort_by(.timestamp) | .[] | "\(.timestamp) \(.decision) \(.tool) \(.actor.name)"'
```

---

## Risk Flags Reference

Risk flags indicate why a decision was made or what triggered during evaluation.

| Flag | Meaning |
|------|---------|
| `unknown_tool` | Tool not defined in policy |
| `pattern_match:{pattern}` | Matched a deny_pattern |
| `cwd_not_allowed` | Working directory not in allowed list |
| `timeout_exceeded` | Requested timeout > max_timeout_ms |
| `path_not_allowed` | File path not in allowed_paths |
| `extension_denied` | File extension in deny_extensions |
| `size_exceeded` | Content size > max_size_bytes |
| `missing_path` | Required path argument not provided |
| `missing_url` | Required URL argument not provided |
| `invalid_url` | URL failed to parse |
| `method_not_allowed` | HTTP method not in allowed_methods |
| `domain_denied` | Domain in deny_domains |
| `needs_approval` | Requires human approval |
| `action:approved` | Human approved the request |
| `action:denied` | Human denied the request |

---

## Security: Secret Redaction

Sensitive data is automatically redacted in logs:

- Fields named `password`, `token`, `secret`, `apiKey`, `api_key`, etc.
- Values starting with `Bearer `
- Values starting with `sk-` (OpenAI keys)

Example:
```json
{
  "argsSummary": "{\"url\":\"https://api.example.com\",\"headers\":{\"Authorization\":\"[REDACTED]\"}}",
}
```

---

## Log Retention

By default, logs are kept indefinitely. You should configure log rotation based on your retention policy.

### Using logrotate (Linux)

```
/path/to/gatekeeper/data/audit/*.jsonl {
    daily
    rotate 90
    compress
    delaycompress
    missingok
    notifempty
}
```

### Manual Cleanup

```bash
# Delete logs older than 90 days
find data/audit -name "*.jsonl" -mtime +90 -delete
```

---

## Integration with Monitoring Tools

### Sending to Datadog

```bash
# Use Datadog Agent's log collection
# /etc/datadog-agent/conf.d/gatekeeper.yaml
logs:
  - type: file
    path: /path/to/gatekeeper/data/audit/*.jsonl
    service: gatekeeper
    source: gatekeeper
```

### Sending to Splunk

```bash
# Forward logs to Splunk HTTP Event Collector
cat data/audit/*.jsonl | while read line; do
  curl -X POST https://splunk:8088/services/collector/event \
    -H "Authorization: Splunk $TOKEN" \
    -d "{\"event\": $line}"
done
```

### Sending to Elasticsearch

```bash
# Bulk index to Elasticsearch
cat data/audit/*.jsonl | jq -c '{index: {_index: "gatekeeper-audit"}}, .' | \
  curl -X POST 127.0.0.1:9200/_bulk -H "Content-Type: application/x-ndjson" --data-binary @-
```

---

## Troubleshooting

### Logs Not Being Written

1. Check directory permissions: `ls -la data/audit/`
2. Check disk space: `df -h`
3. Check Gatekeeper logs for errors

### Finding What Happened to a Request

```bash
# Get the full history of a request
cat data/audit/*.jsonl | jq 'select(.requestId == "your-request-id")' | jq -s 'sort_by(.timestamp)'
```

This shows:
1. Initial decision (allow/approve/deny)
2. Approval consumption (if applicable)
3. Execution result (if applicable)

### Verifying Policy Version

Each log entry includes `policyHash`. Compare with:
```bash
sha256sum policy.yaml
```

This lets you verify which policy was in effect for any decision.

---

## Next Steps

- [Policy Writing Guide](./POLICY_GUIDE.md) - Configure decision rules
- [Approval Workflow Guide](./APPROVALS.md) - Understand approval flow
- [Threat Model](../THREAT_MODEL.md) - Security assumptions
