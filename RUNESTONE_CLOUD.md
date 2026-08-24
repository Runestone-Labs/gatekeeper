# Runestone Gatekeeper Cloud

> **Status: demand validation, not general availability.** The local OSS product works today.
> The hosted team layer described below is a tested product proposal and dogfood protocol; public
> build-out remains frozen until qualified external demand crosses the evidence gate. No payment is
> collected through the beta form. [Describe your workload and $49/month intent](https://gatekeeper.runestonelabs.io/cloud-beta?utm_source=github&utm_medium=cloud_spec&utm_campaign=cloud_beta_validation).

Gatekeeper Cloud coordinates teams. It does not move policy enforcement,
exact actions, execution, budgets, or forensic authority out of the local
Gatekeeper daemon.

## Authority boundary

```text
agent/runtime → local Gatekeeper → allow / hold / deny → local executor
                       │
                       ├── authoritative JSONL/Postgres receipt
                       │
                       └── outbound-only, redacted Cloud protocol
                                  │
                                  └── named team approver
```

Gatekeeper only controls actions routed through it. `gatekeeper doctor` reports
the coverage it can prove and lists known native-tool gaps.

## What never leaves by default

- Raw prompts or model/tool results
- Raw tool arguments or complete commands as blobs
- File contents
- HTTP paths, query strings, bodies, or headers
- Environment values
- Unapproved custom-tool arguments

The local daemon may send tool/actor/decision metadata, a policy hash, an action
digest, cost/token counts, timestamps, risk categories, approval state, and a
purpose-built summary:

- Shell: executable, sanitized arguments, normalized working directory
- File: normalized path, byte count, content hash
- HTTP: method and origin only
- Custom tools: explicitly allowlisted scalar fields only

Every selected value is scanned again for embedded credentials, normalized,
and truncated before it enters the local spool. The Cloud API independently
validates an exact, versioned schema and rejects unknown/raw fields.

## Outbound approval protocol

1. Local Gatekeeper stores the exact pending action.
2. It registers `CloudApprovalV1`: approval ID, instance, policy hash, action
   digest, expiry, and redacted review summary.
3. A named Clerk user records a decision in the workspace inbox.
4. The local daemon long-polls for `CloudDecisionV1`.
5. It applies the decision only if approval ID, action digest, instance, status,
   and expiry match the locally stored action.
6. Local Gatekeeper acknowledges executed, denied, expired, or failed.

Replays, conflicting decisions, stale responses, malformed payloads, and digest
mismatches fail closed. Cloud never receives a callback URL and never reaches
into localhost.

Ordinary locally allowed actions continue during Cloud failure. Remote holds
stay pending and expire safely. Local audit is written before the buffered
Cloud secondary; a bounded local spool retries redacted events later.

The redacted stream has its own receipt chain, which Cloud recomputes before
acceptance. With JSONL as the local authority, each event also carries the
local audit sequence and adjacent receipt hashes. Cloud anchors any history
created before connection and flags later gaps or reordering without receiving
the raw local record needed to recreate its hash. If the bounded spool fills,
Gatekeeper preserves the oldest pending events and never deletes local audit;
the next sequence jump becomes a deterministic finding instead of being hidden.

## Experimental connect flow

```bash
npm --prefix integrations/cli run build
node integrations/cli/dist/index.js connect
node integrations/cli/dist/index.js doctor
```

The CLI is currently a source preview, not a published npm package. This flow requires an explicitly
provisioned test control plane; the public Cloud endpoint should not be assumed available. Device
authorization creates one scoped instance token. Only its SHA-256 hash
is stored in Cloud. The raw token is written to
`~/.config/gatekeeper/cloud.json` with mode `0600` and can be revoked with:

```bash
node integrations/cli/dist/index.js disconnect
```

Disconnecting never disables local enforcement.

## Planned offer under validation

| Plan | Price | Included |
| --- | ---: | --- |
| OSS Local | $0 | Local policy, budgets, approvals, receipts, MCP, Claude Code, OpenClaw |
| Cloud Free (planned) | $0 | 1 instance, 1 approver, hosted inbox, status, 7-day redacted history |
| Cloud Team (planned) | $49/month or $490/year | 5 instances, 5 members, 90-day history, shared policy publishing, exports, drift alerts, weekly reports |

Approvals are observed but not hard-metered during validation.

## Cloud policy behavior

Policy changes are draft-first and must be explicitly published. An instance
validates the downloaded policy and its canonical hash before caching it at
mode `0600`. If Cloud is unavailable, the instance continues with that
last-known-good policy. A fresh Cloud policy source with neither a valid remote
policy nor a valid local cache fails closed at startup.

Local YAML remains the default policy source.
