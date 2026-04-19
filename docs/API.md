# API Reference

HTTP API for Runestone Gatekeeper. All endpoints are JSON in / JSON out.

Base URL: `http://127.0.0.1:3847` (default) or whatever `BASE_URL` is set to.

---

## Table of contents

- [Conventions](#conventions)
- [`GET /health`](#get-health) — service health
- [`POST /tool/:toolName`](#post-tooltoolname) — the main enforcement endpoint
- [`GET /audit`](#get-audit) — query audit log entries
- [`GET /usage`](#get-usage) — call counts aggregated by actor × tool × day
- [`GET /budget`](#get-budget) — current spend vs cap per rule
- [`GET /approve/:id`](#get-approveid) — approve via signed URL
- [`GET /deny/:id`](#get-denyid) — deny via signed URL
- [`POST /approvals/:id/approve`](#post-approvalsidapprove) — programmatic approve
- [`POST /approvals/:id/deny`](#post-approvalsiddeny) — programmatic deny
- [Error shape](#error-shape)
- [Data types](#data-types)

---

## Conventions

- All requests are `Content-Type: application/json`.
- Timestamps are ISO-8601 UTC (`2026-04-19T12:00:00.000Z`).
- Decisions are one of `allow` | `approve` | `deny`.
- `reasonCode` fields are `SCREAMING_SNAKE_CASE` machine-readable codes (e.g. `COMMAND_NOT_ALLOWED`, `BUDGET_EXCEEDED`).
- Audit fields never include full request args — secrets are redacted, structured values hashed.

---

## `GET /health`

Service health + runtime info. Cheap to call; wire to your uptime monitor.

**Response**
```json
{
  "version": "0.3.0",
  "policyHash": "sha256:1ddd938c...",
  "uptime": 1234,
  "pendingApprovals": 3,
  "demoMode": false,
  "providers": {
    "approval": "slack",
    "policy": "yaml"
  },
  "database": {
    "available": true,
    "healthy": true,
    "latencyMs": 3
  },
  "memory": {
    "enabled": false
  }
}
```

`policyHash` changes whenever `policy.yaml` changes — useful for detecting config drift.

---

## `POST /tool/:toolName`

The core endpoint. Every agent tool call comes here. Gatekeeper evaluates policy, optionally routes to human approval, optionally enforces budget, then either executes the tool or returns an approval-required / denied response.

**Path params**
- `toolName` — one of the tools registered in policy (`shell.exec`, `http.request`, `files.write`, `files.read`, `memory.upsert`, `memory.query`, `memory.episode`, `memory.evidence`, `memory.unlink`).

**Request body**
```json
{
  "requestId": "req-abc-123",
  "actor": {
    "type": "agent",
    "name": "research-bot",
    "role": "researcher",
    "runId": "optional-correlation-id"
  },
  "args": {
    "command": "ls /tmp"
  },
  "context": { "conversationId": "opt", "traceId": "opt" },
  "origin": "user_direct",
  "taint": ["external_content"],
  "contextRefs": [{ "type": "message", "id": "msg-id" }],
  "dryRun": false,
  "idempotencyKey": "optional-same-call-dedup-key",
  "capabilityToken": "optional-pre-authorized-token"
}
```

| Field | Required | Notes |
|---|---|---|
| `requestId` | yes | UUID or caller-generated unique string. Used for idempotency default. |
| `actor` | yes | Must include `type`, `name`, `role`. |
| `args` | yes | Tool-specific shape; see [POLICY_GUIDE.md](../POLICY_GUIDE.md). Validated by Zod against the tool's schema. |
| `origin` | no | `user_direct` \| `model_inferred` \| `external_content` \| `background_job`. Used by taint-aware policy rules. |
| `taint` | no | Array of taint labels from untrusted sources. |
| `dryRun` | no | When `true`, evaluates policy and returns the decision without executing. |
| `idempotencyKey` | no | Defaults to `requestId`. Retries with the same key + same args hash return the cached response. |
| `capabilityToken` | no | Pre-authorized token that converts an `approve` decision into `allow`. |

**Response — `allow`** (`200 OK`)
```json
{
  "decision": "allow",
  "requestId": "req-abc-123",
  "success": true,
  "result": { "stdout": "file1\nfile2\n", "stderr": "", "exitCode": 0 },
  "error": null,
  "reasonCode": "POLICY_ALLOW",
  "humanExplanation": "Policy allows \"shell.exec\".",
  "remediation": null,
  "executionReceipt": {
    "startedAt": "2026-04-19T12:00:00.000Z",
    "completedAt": "2026-04-19T12:00:00.123Z",
    "durationMs": 123
  },
  "policyVersion": "sha256:1ddd938c...",
  "idempotencyKey": "req-abc-123"
}
```

**Response — `approve`** (`202 Accepted`)
```json
{
  "decision": "approve",
  "requestId": "req-abc-123",
  "approvalId": "apr-xyz-456",
  "expiresAt": "2026-04-19T13:00:00.000Z",
  "reasonCode": "POLICY_APPROVAL_REQUIRED",
  "humanExplanation": "Policy requires human approval before running \"shell.exec\".",
  "remediation": "Request approval from the user to proceed.",
  "approvalRequest": { "approvalId": "apr-xyz-456", "expiresAt": "...", "reasonCode": "...", "humanExplanation": "...", "remediation": "..." },
  "policyVersion": "sha256:...",
  "idempotencyKey": "req-abc-123"
}
```

The approver clicks the signed URL (sent via the configured approval provider). After approval, the caller should retry the same request — the capability flow turns `approve` into `allow`.

**Response — `deny`** (`403 Forbidden`)
```json
{
  "decision": "deny",
  "requestId": "req-abc-123",
  "reasonCode": "COMMAND_NOT_ALLOWED",
  "humanExplanation": "Shell command \"rm -rf /\" matches deny pattern.",
  "remediation": "Use an allowed command or update policy.allowed_commands.",
  "denial": {
    "reasonCode": "COMMAND_NOT_ALLOWED",
    "humanExplanation": "...",
    "remediation": "..."
  },
  "policyVersion": "sha256:...",
  "idempotencyKey": "req-abc-123"
}
```

Common `reasonCode` values: `UNKNOWN_TOOL`, `MISSING_ACTOR_ROLE`, `COMMAND_NOT_ALLOWED`, `PATH_NOT_ALLOWED`, `DOMAIN_NOT_ALLOWED`, `SIZE_EXCEEDED`, `TIMEOUT_EXCEEDED`, `TAINTED_WRITE_SYSTEM_PATH`, `PRINCIPAL_PATTERN_DENIED`, `IDEMPOTENCY_KEY_CONFLICT`, `BUDGET_EXCEEDED`.

**Response — error** (`400`/`404`/`409`/`500`)
See [Error shape](#error-shape).

---

## `GET /audit`

Query the audit log. Requires `AUDIT_SINK=postgres` (the jsonl sink doesn't expose a query endpoint).

**Query params**
| Name | Type | Default | Notes |
|---|---|---|---|
| `since` | ISO-8601 | unbounded | Lower bound on `timestamp`. |
| `until` | ISO-8601 | unbounded | Upper bound on `timestamp`. |
| `tool` | string | — | Filter by tool name. |
| `decision` | string | — | Filter by decision. |
| `limit` | number | 200 (max 500) | |
| `offset` | number | 0 | |

**Response**
```json
{
  "entries": [
    {
      "timestamp": "2026-04-19T12:00:00.000Z",
      "requestId": "...",
      "tool": "shell.exec",
      "decision": "allow",
      "actor": { "type": "agent", "name": "...", "role": "..." },
      "argsSummary": "...",
      "argsHash": "sha256:...",
      "resultSummary": "...",
      "executionReceipt": { "durationMs": 123, "startedAt": "...", "completedAt": "..." },
      "riskFlags": [],
      "reasonCode": "POLICY_ALLOW",
      "humanExplanation": "...",
      "remediation": null,
      "policyHash": "sha256:...",
      "gatekeeperVersion": "0.3.0",
      "approvalId": null,
      "origin": "user_direct",
      "taint": [],
      "contextRefs": []
    }
  ],
  "count": 1,
  "offset": 0,
  "limit": 200
}
```

---

## `GET /usage`

Aggregated call counts per actor × tool × day. Powers per-actor metering and feeds the budget endpoint.

Requires an audit sink that implements aggregation (`jsonl` does an in-memory scan; `postgres` runs a single GROUP BY query). Returns `501` if the active sink can't aggregate.

**Query params**
| Name | Type | Default | Notes |
|---|---|---|---|
| `since` | ISO-8601 | unbounded | |
| `until` | ISO-8601 | unbounded | |
| `actorName` | string | — | Filter. |
| `actorRole` | string | — | Filter. |
| `tool` | string | — | Filter. |
| `limit` | number | 500 (max 5000) | |

**Response**
```json
{
  "rows": [
    {
      "actorName": "research-bot",
      "actorRole": "researcher",
      "tool": "http.request",
      "day": "2026-04-19",
      "callCount": 342,
      "totalDurationMs": 47521,
      "decisions": { "allow": 170, "executed": 170, "deny": 2 }
    }
  ],
  "totalCalls": 342,
  "distinctActors": 1,
  "distinctTools": 1,
  "filter": { "since": "...", "until": "...", "limit": 500 },
  "generatedAt": "2026-04-19T12:00:00.000Z"
}
```

---

## `GET /budget`

Current spend vs cap for each configured budget rule. Uses the active audit sink's aggregation + each tool's `cost_usd` to compute running totals.

**Query params**
| Name | Type | Notes |
|---|---|---|
| `actorName` | string | If set, only rules matching this actor name are returned. |
| `actorRole` | string | If set, only rules matching this actor role are returned. |

**Response (budgets configured)**
```json
{
  "rules": [
    {
      "name": "researcher-daily",
      "match": { "actor_role": "researcher" },
      "window": "day",
      "max_usd": 5.00,
      "mode": "hard"
    }
  ],
  "statuses": [
    {
      "rule": { "name": "researcher-daily", "match": { "actor_role": "researcher" }, "window": "day", "max_usd": 5.00, "mode": "hard" },
      "status": {
        "rule": { "...": "..." },
        "windowStart": "2026-04-18T12:00:00.000Z",
        "windowEnd": "2026-04-19T12:00:00.000Z",
        "currentUsd": 2.47,
        "remainingUsd": 2.53,
        "exceeded": false,
        "byTool": [
          { "tool": "http.request", "callCount": 247, "costUsd": 2.47 }
        ]
      }
    }
  ],
  "generatedAt": "2026-04-19T12:00:00.000Z"
}
```

**Response (no budgets configured)**
```json
{
  "rules": [],
  "statuses": [],
  "note": "No budgets configured in policy."
}
```

`status` is `null` when the sink can't aggregate; treat that as "enforcement inactive" rather than "over budget."

---

## `GET /approve/:id`

Human-facing approval endpoint. Called when the approver clicks the signed URL sent via the approval provider.

**Query params**
- `sig` — HMAC signature (provided by gatekeeper in the URL; don't construct by hand)
- `exp` — expiry timestamp (provided)
- `action` — `approve`

Returns a small HTML confirmation page. Once consumed, the approval transitions from `pending` → `approved` and cannot be reused.

Single-use, time-limited (default 1h), no cookies, no session. Safe to share via email or Slack.

---

## `GET /deny/:id`

Same as `/approve/:id` but rejects. `action=deny`.

---

## `POST /approvals/:id/approve`

Programmatic approval (e.g. from another service). Requires either:

- `sig` + `exp` in the request body (same signed URL payload), OR
- `Authorization: Bearer $GATEKEEPER_SECRET` header, OR
- `X-Gatekeeper-Secret: $GATEKEEPER_SECRET` header

**Request**
```json
{ "sig": "hmac-...", "exp": "2026-04-19T13:00:00.000Z" }
```

**Response** — `200 OK` with the approval record, or `403`/`410` with a reason.

---

## `POST /approvals/:id/deny`

Same as above with `action=deny`.

---

## Error shape

All error responses follow:

```json
{
  "error": "Human-readable description",
  "reasonCode": "OPTIONAL_MACHINE_READABLE_CODE",
  "requestId": "..."
}
```

Common HTTP codes:
- `400` — request validation failed (bad JSON, missing fields, schema mismatch)
- `403` — policy deny or budget exceeded (returns the full deny response, not this shape)
- `404` — unknown tool or unknown approval ID
- `409` — idempotency conflict (same key, different args hash; or approval already consumed)
- `410` — approval expired or consumed
- `500` — internal error; check logs
- `501` — feature not supported by configured provider (e.g. `/usage` with `jsonl` sink used to be unsupported before in-memory aggregation was added)
- `503` — dependency unavailable (e.g. Postgres audit sink can't reach the database)

---

## Data types

### Actor
```ts
type Actor = {
  type: 'agent' | 'user'
  name: string
  role: string      // must match a principal rule if principals[] is configured
  runId?: string
}
```

### Decision
```ts
type Decision = 'allow' | 'approve' | 'deny' | 'executed' | 'approval_consumed'
// 'allow'/'approve'/'deny' appear in /tool/:toolName responses.
// 'executed' and 'approval_consumed' only appear in audit rows.
```

### Origin
```ts
type Origin = 'user_direct' | 'model_inferred' | 'external_content' | 'background_job'
```

### BudgetWindow / BudgetMode
```ts
enum BudgetWindow { Hour = 'hour', Day = 'day', Week = 'week' }
enum BudgetMode   { Hard = 'hard', Soft = 'soft' }
```

For the full type surface, import from `@runestone-labs/gatekeeper-client`:

```ts
import type {
  ToolRequest,
  GatekeeperResponse,
  DenialDetails,
  ApprovalRequestDetails,
  ExecutionReceipt,
  AuditEntry,
  UsageSummary,
  BudgetRule,
  BudgetStatus,
} from '@runestone-labs/gatekeeper-client';
```
