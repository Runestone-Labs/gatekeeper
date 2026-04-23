# Deploy Guide

Production deployment patterns for Runestone Gatekeeper. This doc assumes you've already run the [Quick Start](../README.md#quick-start-with-docker) locally and understand the basic request/response flow.

---

## Table of Contents

- [Pre-deploy checklist](#pre-deploy-checklist)
- [Deployment modes](#deployment-modes)
- [Docker Compose (single host)](#docker-compose-single-host)
- [systemd (bare VM)](#systemd-bare-vm)
- [Kubernetes (future)](#kubernetes-future)
- [Environment variables](#environment-variables)
- [Provider configuration](#provider-configuration)
- [Database setup (Postgres)](#database-setup-postgres)
- [Reverse proxy + TLS](#reverse-proxy--tls)
- [Backups](#backups)
- [Upgrading](#upgrading)
- [Operating notes](#operating-notes)

---

## Pre-deploy checklist

Before any production deploy, confirm:

- [ ] `GATEKEEPER_SECRET` is ≥32 random characters and stored in your secrets manager (not in git).
- [ ] `DEMO_MODE=true` is **unset** in production — it exposes approval URLs in API responses, which is useful for local testing and catastrophic in prod.
- [ ] `GATEKEEPER_HOST` is bound to an interface that only your agents can reach. If you run agents on the same host, `127.0.0.1` is correct.
- [ ] `policy.yaml` has been reviewed. The example policy is starter content, not a production baseline.
- [ ] An audit sink is configured (`AUDIT_SINK=jsonl` or `postgres`). jsonl is fine for single-host; Postgres is required for multi-host or `/usage` aggregation.
- [ ] An approval provider is configured if `approve` decisions exist in the policy (`APPROVAL_PROVIDER=local|slack|runestone`). The `local` provider requires a reverse proxy so signed URLs resolve.
- [ ] Logs go somewhere you can grep — default is stdout, suitable for `journalctl` or a Docker logging driver.
- [ ] A process supervisor restarts the service on crash (`systemd`, `docker compose --restart`, `kubectl`, etc.).
- [ ] Backups are scheduled for the data directory (`./data/`) and Postgres if used.

---

## Deployment modes

Gatekeeper is intentionally small — one process, one port, one policy file, one data directory.

| Mode | When to use |
|---|---|
| **Docker Compose** | Single host, single tenant. Simplest production shape. Works on a $5 VPS. |
| **systemd** | You already run services this way and don't want Docker on the host. |
| **Kubernetes** | Multi-tenant, multi-region. Requires Postgres audit sink for aggregation across pods. Not officially supported yet. |

---

## Docker Compose (single host)

The bundled `docker-compose.yaml` is production-capable with a few changes.

1. **Override `docker-compose.yaml`** via `docker-compose.override.yaml` (already `.gitignore`d):

   ```yaml
   services:
     gatekeeper:
       # Remove demo mode
       environment:
         - DEMO_MODE=false
         - AUDIT_SINK=postgres
         - DATABASE_URL=postgres://gatekeeper:SECRET@db:5432/gatekeeper
         - APPROVAL_PROVIDER=slack
         - SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
         - LOG_LEVEL=warn
       volumes:
         - ./policy.yaml:/app/policy.yaml:ro  # your customized policy
         - gatekeeper-data:/app/data
       restart: unless-stopped

     db:
       image: postgres:16-alpine
       environment:
         POSTGRES_DB: gatekeeper
         POSTGRES_USER: gatekeeper
         POSTGRES_PASSWORD: SECRET   # use a secrets file in production
       volumes:
         - gatekeeper-db:/var/lib/postgresql/data
       restart: unless-stopped

   volumes:
     gatekeeper-db:
   ```

2. **Run migrations once** against the new database:

   ```bash
   docker compose run --rm gatekeeper npm run db:push
   ```

3. **Start the stack:**

   ```bash
   docker compose up -d
   docker compose logs -f gatekeeper
   ```

4. **Verify:**

   ```bash
   curl -sf http://127.0.0.1:3847/health
   ```

---

## systemd (bare VM)

If you prefer systemd over Docker:

```ini
# /etc/systemd/system/gatekeeper.service
[Unit]
Description=Runestone Gatekeeper
After=network.target postgresql.service

[Service]
Type=simple
User=gatekeeper
WorkingDirectory=/opt/gatekeeper
EnvironmentFile=/etc/gatekeeper/env
ExecStart=/usr/bin/node --enable-source-maps dist/server.js
Restart=on-failure
RestartSec=2s

# Tighten the blast radius
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
NoNewPrivileges=yes
ReadWritePaths=/opt/gatekeeper/data

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo adduser --system --group --home /opt/gatekeeper gatekeeper
# Deploy compiled dist/ and policy.yaml to /opt/gatekeeper
sudo install -m 600 /path/to/env /etc/gatekeeper/env  # secrets here
sudo systemctl daemon-reload
sudo systemctl enable --now gatekeeper
sudo journalctl -fu gatekeeper
```

The repo currently runs via `tsx` — for systemd you'll want to build to plain JS first. TypeScript-to-JS build is on the roadmap; until then, run `tsx dist/server.js` from systemd with `node` replaced by `npx tsx`.

---

## Kubernetes (future)

No official manifests yet. The shape will look like:

- Single Deployment (can scale horizontally with Postgres audit sink)
- ConfigMap for `policy.yaml`
- Secret for `GATEKEEPER_SECRET`, `DATABASE_URL`, `SLACK_WEBHOOK_URL`
- Service + Ingress for the approval UI

PRs welcome.

---

## Environment variables

See `.env.example` for the full list. The critical ones:

| Variable | Required | Default | Notes |
|---|---|---|---|
| `GATEKEEPER_SECRET` | **yes** | — | HMAC key for approval signatures. ≥32 chars. Rotate by updating env + restarting; in-flight signed URLs become invalid. |
| `GATEKEEPER_HOST` | no | `127.0.0.1` | Bind address. Use `0.0.0.0` inside a container. |
| `GATEKEEPER_PORT` | no | `3847` | |
| `BASE_URL` | no | `http://localhost:3847` | Public URL used in signed approval links. Must match the URL the approver sees. |
| `DEMO_MODE` | no | `false` | Exposes approval URLs in API responses. Do not enable in prod. |
| `POLICY_PATH` | no | `./policy.yaml` | |
| `DATA_DIR` | no | `./data` | Audit logs, approvals, idempotency records. |
| `AUDIT_SINK` | no | `jsonl` | `jsonl` \| `postgres` \| `runestone`. |
| `APPROVAL_PROVIDER` | no | `local` | `local` \| `slack` \| `runestone`. |
| `POLICY_SOURCE` | no | `yaml` | `yaml` \| `runestone`. |
| `DATABASE_URL` | only for `postgres` sink or memory module | — | `postgres://user:pass@host:port/db` |
| `SLACK_WEBHOOK_URL` | only for `slack` provider | — | Incoming-webhook URL. |
| `LOG_LEVEL` | no | `info` | `trace` \| `debug` \| `info` \| `warn` \| `error` |
| `ENABLE_MEMORY` | no | auto | `true` enables the optional graph/memory tools (requires `DATABASE_URL`). |

---

## Provider configuration

Gatekeeper's three provider slots are independent:

- **Approval provider** — how humans get the approval notification and click approve/deny.
- **Audit sink** — where every decision goes for the record.
- **Policy source** — where the allow/deny/approve rules come from.

Default stack is `local` + `jsonl` + `yaml` — everything on disk, everything on one host. Swap each independently:

```bash
APPROVAL_PROVIDER=slack SLACK_WEBHOOK_URL=https://...
AUDIT_SINK=postgres DATABASE_URL=postgres://...
POLICY_SOURCE=yaml POLICY_PATH=/etc/gatekeeper/policy.yaml
```

The `runestone` provider slots exist as stubs for a future hosted control plane. They currently throw if used.

---

## Database setup (Postgres)

Required for `AUDIT_SINK=postgres`, `/usage` aggregation beyond single-host, and the optional memory/graph module.

```bash
createdb gatekeeper
createuser gatekeeper -P   # prompt for password
psql -d gatekeeper -c "GRANT ALL ON DATABASE gatekeeper TO gatekeeper"

# Point the app at it
export DATABASE_URL="postgres://gatekeeper:SECRET@localhost:5432/gatekeeper"

# Apply schema
npm run db:push
```

The schema is managed via drizzle-kit. `db:push` is fine for dev; use `db:generate` + `db:migrate` for production:

```bash
npm run db:generate      # creates a migration from schema changes
npm run db:migrate       # applies pending migrations
```

Memory module (optional): the knowledge-graph tools require [Apache AGE](https://age.apache.org/) on top of Postgres. If you don't use the memory tools, you don't need AGE.

---

## Reverse proxy + TLS

Approval URLs are signed against `BASE_URL`. In production you almost certainly want TLS + a stable hostname:

```
# nginx
server {
  listen 443 ssl http2;
  server_name gatekeeper.example.com;
  ssl_certificate     /etc/letsencrypt/live/gatekeeper.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/gatekeeper.example.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:3847;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
  }
}
```

Then set `BASE_URL=https://gatekeeper.example.com` and restart.

The approval flow uses HMAC-signed URLs and single-use tokens — it does not rely on cookies or session state — so a standard pass-through proxy is sufficient. No special CSRF handling is needed.

---

## Backups

Back up these paths:

- **`$DATA_DIR/approvals/`** — pending approval records. Losing this means in-flight approvals are unrecoverable (not catastrophic, callers will retry).
- **`$DATA_DIR/audit/`** (when `AUDIT_SINK=jsonl`) — the audit log. **This is the authoritative record. Back up daily at minimum.**
- **`$DATA_DIR/idempotency/`** — short-lived request dedup state. Safe to lose.
- **Postgres** (when `AUDIT_SINK=postgres`) — same as audit/. `pg_dump` nightly, retain 30+ days.
- **`policy.yaml`** — version-controlled separately, but snapshot alongside data so a backup represents a consistent decision state.
- **`.env`** — handled by your secrets manager, not this backup.

Audit log format is append-only JSONL, so backups can be incremental (`tail -f`-style) if you want cheap offsite replication.

---

## Upgrading

1. Read `CHANGELOG.md` for breaking changes.
2. Snapshot the database and data directory.
3. Run `git pull && npm install && npm run build`.
4. Run `npm run db:migrate` if there are new migrations.
5. Restart the service.
6. Verify with `curl -sf $BASE_URL/health` — the `version` and `policyHash` fields should reflect the upgrade.

Rolling back: stop the service, restore data + schema from the snapshot, redeploy the previous container/binary, restart. The audit log is append-only so no rollback required on that side.

---

## Operating notes

- **Health endpoint:** `GET /health` returns JSON with version, policy hash, uptime, pending approvals, provider names, database status, memory module status. Wire this to your uptime monitor.
- **Policy hash:** included in every audit entry. Changes when the policy file changes. Useful for "which policy was in effect when this decision was made?" forensics.
- **Idempotency:** tool requests are deduplicated by `idempotencyKey` (defaults to `requestId`). If an agent retries after a network error, it gets the original decision back, not a second audit entry.
- **Rate limits:** currently implemented at the budget-enforcement layer (per-actor USD cap per rolling window). Per-tool rate limits live in the tool policy (`max_timeout_ms`, `max_size_bytes`, etc.); global request-rate limiting is not yet built.
- **Logging PII:** the `argsSummary` field in audit entries has secrets redacted via `redactSecrets()`, but free-form prompts can still contain PII. If this matters in your environment, run the audit log through a DLP scanner before retention.
- **Clock skew:** signed approval URLs include an expiry timestamp. If the approver's clock is significantly off from the gatekeeper's, approvals may appear expired. Run NTP.

---

## Non-obvious behaviors

Things that often surprise operators on the first deploy. None of these are
bugs — they're design choices with reasons — but they bite if you don't know
them.

### Deny patterns match canonicalized JSON, not raw commands

`deny_patterns` are regexed against the canonicalized JSON of the request
args, not the shell command or URL directly. Canonicalization sorts object
keys and JSON-stringifies the whole args object. So:

```yaml
deny_patterns:
  - "rm -rf"      # matches "command":"rm -rf /"
  - "> /dev/"     # matches across any arg field
```

Patterns are **case-insensitive**. Whitespace differences in the original
input survive canonicalization, so `rm  -rf` (two spaces) will *not* match
`rm -rf` (one space). If you care about whitespace-evasion, use a
whitespace-tolerant pattern: `rm\\s+-rf`.

### Policy is loaded at startup — no hot reload

The policy file is read once when the process starts. Editing `policy.yaml`
while the server is running has no effect until you restart. The `/health`
endpoint's `policyHash` field is your source of truth for which policy is
live.

If you need hot reload, restart the service on file change (nodemon, systemd
`PathChanged`, or a file-watcher sidecar). The audit log's `policyHash` will
tick over at the restart boundary.

### There is no memory delete

The memory module has no delete endpoint. `memory.upsert` with an `id`
updates in place; episodes and evidence are append-only.

This is intentional for audit integrity. If you need to retract something,
write a correction episode (see
[KG_PATTERNS.md](KG_PATTERNS.md#the-no-delete-model)) or, for GDPR right-to-be-forgotten, issue direct SQL against
the `entities`/`episodes` tables and record the deletion in a separate
compliance log.

### SSRF protection re-validates after redirects

`http.request` resolves the hostname and blocks private IPs before the
first request. After any 3xx redirect, it resolves the *new* hostname and
blocks again. This defeats DNS-rebinding and redirect-to-internal attacks.

Redirects are also **GET-only** — a `POST` that gets a 301/302/307/308 is
rejected rather than followed. If you need to follow a POST redirect,
handle it in the caller.

### Response header allowlist (not blocklist)

Only a small set of headers is returned from `http.request`:
`content-type`, `content-length`, `cache-control`, `etag`, `last-modified`,
`date`, `x-request-id`. Everything else is dropped before returning to the
agent.

If your integration depends on a custom header (e.g. `x-rate-limit-remaining`),
you won't see it without patching `SAFE_RESPONSE_HEADERS` in
`src/tools/core/httpRequest.ts`. PR welcome if this is common.

### Approval-provider failures don't block requests

When a tool decision is `approve`, the server creates the approval record
and immediately returns 202 to the caller. Sending the notification (Slack
webhook, etc.) happens in a fire-and-forget promise. If Slack is down, the
approval still exists — you just won't get pinged. The approver can still
hit the approve/deny URL directly.

Check logs for `Failed to send approval notification` to catch provider
outages. Consider adding an uptime check against your Slack webhook
separately.

### Budget enforcement reads from the audit log

Current spend is computed by scanning the active audit sink for calls in
the window, summing `cost_usd` from the tool policy. Implications:

- `AUDIT_SINK=jsonl`: budget lookups do a file scan each request. Fine up
  to a few thousand calls per window. Scales badly beyond that.
- `AUDIT_SINK=postgres`: single GROUP BY query per budget rule. Scales
  comfortably.
- If you swap sinks mid-flight, spend history is lost — the new sink starts
  empty.

For production multi-agent deployments with budgets, use Postgres.

### Capability tokens are bound to exact args

A capability token's `argsHash` is computed over the canonicalized args at
mint time. *Any* change to the args — even an added optional field, a
reordered key, or a whitespace difference in a string — produces a
different hash, and the token is rejected with `CAPABILITY_ARGS_MISMATCH`.

This is the intended behavior: a token that pre-authorizes "run `pg_dump
--table=users`" should not also authorize "run `pg_dump --table=users
--output=/tmp/stolen`". If you need flexibility, mint tokens narrowly and
often, or move the flexible operation to a non-`approve` tool.

### Approval URLs use `BASE_URL`, not request host

Signed approval URLs are built with `BASE_URL` as their prefix. If you
deploy behind a reverse proxy and forget to set `BASE_URL` to the
public-facing hostname, the URLs will point at `http://localhost:3847` and
approvers hitting them from outside will get connection errors.

The HMAC signature is over the URL path + expiry, not the hostname, so
the signature itself is portable — only the prefix is wrong. Fix by
setting `BASE_URL=https://your-public-hostname.example.com` and restarting.

### The /audit endpoint requires Postgres

`GET /audit` queries the `audit_logs` table directly via Drizzle. It
requires `DATABASE_URL` to be set *and* returns empty if your audit sink
is `jsonl` (the table is there but unused). If you want `/audit` to work,
set `AUDIT_SINK=postgres`.

The `/usage` and `/budget` endpoints work with either sink — they go
through the sink's `summarizeUsage()` method, which is implemented for
both `jsonl` (in-memory scan) and `postgres` (SQL aggregation).

### Idempotency records have no TTL

Idempotency records are stored in `$DATA_DIR/idempotency/` and kept
indefinitely. On a very busy server this directory grows unboundedly. If
that's a concern, add a cron job to delete records older than a few days:

```bash
find "$DATA_DIR/idempotency" -name '*.json' -mtime +7 -delete
```

Losing an idempotency record means a retry with the same key will execute
a second time. If your retry semantics depend on this, keep the TTL
generous.

---

## Getting help

- Bugs and features: [GitHub Issues](https://github.com/Runestone-Labs/gatekeeper/issues)
- Security: [SECURITY.md](../SECURITY.md)
- Threat model: [THREAT_MODEL.md](../THREAT_MODEL.md)
- Policy reference: [POLICY_GUIDE.md](../POLICY_GUIDE.md)
