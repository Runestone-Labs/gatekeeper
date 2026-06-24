# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0] - 2026-06-23

### Added

- **Real per-token model-call metering.** The Anthropic proxy now parses
  upstream token usage and stamps `model`, `usage`, and a real per-token
  `costUsd` onto the execution audit row — non-streaming JSON is buffered and
  parsed; SSE responses are `tee()`'d so the client streams token-by-token
  uninterrupted while a background consumer reads usage off the second branch.
  A self-contained pricing table (`src/pricing/`) computes cost (cache-tier
  aware) and refreshes daily from LiteLLM's community JSON. Closes the gap where
  proxied model calls contributed **$0** to budgets.
- **Per-run budgets.** A new `scope: run` budget caps a *single agentic run*
  (all calls sharing `actor.runId`) by USD, tokens, and/or call count — the unit
  where recursive/agentic burn compounds. Denies `RUN_BUDGET_EXCEEDED` at the
  action boundary via the existing allow/approve/deny + signed-approval
  machinery; the Anthropic proxy enforces it *before* the costly model call.
  An actor may now carry both an actor-scoped guardrail and a per-run cap (all
  matching rules are enforced). Ships disabled (observe-first).
- **Run correlation (`runId`)** threaded end-to-end: `x-runestone-run-id` on the
  proxy, `runId` on the TypeScript client, and `GATEKEEPER_RUN_ID` for the MCP
  server and Claude Code hook (hook falls back to the session id). For callers
  that can't set headers (e.g. the Claude Agent SDK, which only exposes
  `ANTHROPIC_BASE_URL`), the proxy also recovers the run id from an
  `…/anthropic/_run/<runId>` base-URL prefix.
- `/usage` and budget aggregation now expose real summed `totalCostUsd` /
  `totalTokens` per bucket and support a `runId` filter (jsonl + Postgres sinks).

### Changed

- `audit_logs` gains `model` / `usage` / `cost_usd` columns (drizzle migration
  `0003`). `drizzle.config.ts` now targets the schema files directly so
  `db:generate` works (the barrel's ESM `.js` re-export broke drizzle-kit's
  loader). `AuditEntry`, `logToolExecution`, `UsageRow`, `UsageFilter`, and
  `BudgetRule` gain optional fields; all changes are backward compatible.

## [0.5.0] - 2026-06-19

### Added

- **`@runestone-labs/gatekeeper-mcp`** *(new package under
  `integrations/mcp-server/`)* — a stdio MCP server that lets any MCP client
  (Claude Desktop, Claude Code, Cursor) run tool calls — `shell_exec`,
  `files_write`, `http_request`, a generic `gatekeeper_call`, and
  `gatekeeper_health` — only by routing every call through Gatekeeper
  (policy → approval → audit). Identity / role / origin are pinned
  server-side (the model can't escalate via tool arguments); it fails closed
  (deny, pending approval, or any malformed Gatekeeper response surfaces as an
  error, never a success). Published to npm and listed on the MCP Registry
  (preview) as `io.github.runestone-labs/gatekeeper` via `server.json` +
  GitHub OIDC publish workflow.

### Changed

- **`@runestone-labs/gatekeeper-client`** — broadened npm keywords (`agentic`,
  `llm`, `guardrails`, `ai-safety`, `tool-use`, `permissions`) for
  discoverability. No API change.

## [0.4.0] - 2026-04-27

### Added

- **Sensitive Boundary Protection rule pack** — a built-in policy layer that
  catches when an agent crosses a sensitive local resource boundary
  (Keychain, SSH keys, cloud credentials, browser profiles, package-registry
  tokens, env files) even when the agent's stated intent is benign. Motivated
  by the failure mode where a coding agent debugging a Puppeteer / Chromium
  prompt escalates from editing launch flags into `security
  find-generic-password` and `security delete-generic-password` against the
  user's macOS Keychain.
  - 17 default rules covering macOS Keychain (read / dump / delete), SSH
    private keys, AWS / GCP / Azure credentials, `.env` reads, npm / PyPI /
    git auth tokens, `gh auth token`, Chromium-family and Firefox browser
    profiles, destructive browser-profile deletion, and broad home-directory
    secret greps.
  - Each rule classifies the action with `category`, `resource_class`,
    `risk` (`low | medium | high | critical`), and an optional
    `safer_alternative` redirect. All four are mirrored into `riskFlags`
    (`boundary:<id>`, `category:<x>`, `resource:<x>`, `risk:<x>`) so existing
    audit consumers see the signal without code changes.
  - Defaults always load. YAML overrides under `sensitive_boundaries:` in
    `policy.yaml` merge by `id` — same id replaces a default, new ids
    append, `effect: allow` whitelists a known-safe path. Validation
    (regex compile, enum checks, duplicate-id detection) runs at policy-load
    time so misconfiguration fails fast.
  - Boundary check runs after taint and before principal / tool-level
    deny patterns, so an over-permissive role or a default `allow` tool can
    not bypass it.
  - Reference YAML dump at `policies/sensitive-boundaries.yaml`; example
    overrides in `policy.example.yaml`; demo fixture at
    `examples/sensitive-boundaries/keychain-scope-creep.json`.
- **`@runestone-labs/gatekeeper-claude-code`** *(new package under
  `integrations/claude-code/`)* — Claude Code PreToolUse hook that gates
  `Bash`, `Write`, `Edit`, and `WebFetch` through a running Gatekeeper
  server. Hook posts `dryRun: true` to `POST /tool/:toolName` so Claude
  Code remains the sole executor; on `deny` / `require_approval` it returns
  Claude Code's `{ "decision": "block", "reason": "..." }` envelope so the
  model can pivot. Fail-open by default; `GATEKEEPER_FAIL_CLOSED=1` flips
  to fail-closed. Drop-in `settings.example.json` snippet wires the hook
  into `~/.claude/settings.json`.
- **`PolicyEvaluation` extended** — added optional `category`, `resourceClass`,
  `risk`, `saferAlternative` fields populated by boundary-rule matches. All
  optional and backwards-compatible; existing consumers ignore them.

### Changed

- **`Policy` shape** — added optional `sensitive_boundaries` array.
  Defaults are merged in at load time, so existing policies with no
  `sensitive_boundaries:` section automatically pick up the built-in pack.

## [0.3.2] - 2026-04-23

### Fixed

- **Client: HTTP method type** — `HttpRequestArgs.method` narrowed from
  `'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS'` to
  `'GET' | 'POST'` to match the server's actual schema. Callers using other
  methods were silently rejected at the server boundary; the type now
  surfaces this at compile time.
- **Client: `FilesWriteArgs.encoding`** — narrowed from `'utf8' | 'base64'` to
  `'utf8'`. Base64 was never implemented server-side.
- **Client README** — install instructions now reference
  `npm install @runestone-labs/gatekeeper-client` instead of copy-paste.
- **Docs** — corrected stale version strings across README, SECURITY.md,
  AUDIT_LOGS.md, API.md, and MEMORY.md. Removed reference to a
  non-existent `files.read` tool. Clarified that `/usage` aggregation works
  with both jsonl and postgres sinks.

### Added

- **Client: `HttpRequestArgs.timeout_ms`** — per-call timeout override field
  (clamped by `policy.max_timeout_ms` on the server).
- **Docs: `docs/KG_PATTERNS.md`** — practical guide to using the memory
  module: entity modeling, episode roles, evidence chains, provenance as
  workflow tag, `notProvenance` for content/telemetry separation,
  query-mode dispatch, Cypher gotchas, no-delete/consolidation model.
- **Docs: "Practical Integration Patterns" in INTEGRATING_AGENTS.md** —
  role-per-agent via principals, taint propagation, capability-token
  minting flow, idempotent retries, dry-run preflight, wiring to Claude
  Code / MCP / OpenClaw.
- **Docs: "Non-obvious behaviors" in DEPLOY.md** — canonicalized-JSON deny
  patterns, no policy hot reload, no memory delete, post-redirect SSRF
  re-validation, GET-only redirects, response-header allowlist,
  fire-and-forget approval notifications, budget aggregation source,
  capability-token args-binding, `BASE_URL` for signed URLs, idempotency
  TTL caveats.
- **Docs: `/budget` section in POLICY_GUIDE.md** — documents the `budgets:`
  block, `cost_usd` per tool, and how budget enforcement interacts with
  policy decisions and capability tokens.
- **Docs: MEMORY.md** — documents `provenance`, `notProvenance`,
  `detailsContain`, and `until` filters on `memory.query`; raised `limit`
  cap to 2000; added `prediction_market` and `thesis` entity types.
- **Docs: SECURITY.md** — updated supported versions to 0.3.x.

## [0.3.1] - 2026-04-22

### Added

- **`memory.query` `notProvenance` filter** — exclude episodes whose provenance matches any entry in the list. Useful for hiding high-volume telemetry (`cgm-sync`, `health-tracking`, etc.) from content-focused queries so the top-N isn't dominated by sensor data. Server caps the list at 20 entries.
- **Client: `MemoryQueryArgs` type** exported from `@runestone-labs/gatekeeper-client` for autocomplete when building `memory.query` payloads.

## [0.3.0] - 2026-02-06

### Added

- **v1 Tool Call Envelope** - Request protocol with origin tracking, taint labels, and context references
  - `origin` field: `user_direct`, `model_inferred`, `external_content`, `background_job`
  - `taint` labels for tracking untrusted data provenance
  - `contextRefs` for linking requests to triggering messages, URLs, or documents
- **Principal-based policies** - Role-scoped policy evaluation
  - Per-role tool decisions and deny patterns via `principals.yaml`
  - Policy composition with `extends` and `principals_file` directives
  - Taint-aware evaluation (deny tainted requests for sensitive tools)
- **Capability tokens** - Pre-authorized tool execution without manual approval
  - HMAC-SHA256 signed tokens scoped to tool + args hash
  - Optional actor/role constraints and expiry enforcement
  - CLI: `npm run capability:create`
- **Idempotency** - Safe retries with file-backed deduplication
  - Key-based deduplication with args hash verification
  - Response caching for deterministic replay
- **Memory tools** - `memory.evidence` for attaching provenance sources, `memory.unlink` for removing relationships, full-text entity search
- **Tool hardening**
  - SSRF: IP re-validation after redirects, DNS rebinding defenses
  - Files: path resolution with symlink protection
  - Shell: expanded constraints and output limits
- **Policy replay** - `npm run replay:policy` replays audit log entries against current policy
- **Dry-run mode** - Evaluate policy without executing tools

### Changed

- Approval routes accept both GET (signed URLs) and POST (secret-authenticated) for approve/deny
- Audit entries now include v1 envelope fields (origin, taint, contextRefs)
- TypeScript client and OpenClaw plugin updated for v1 request format
- All documentation guides expanded with v1 features

### Fixed

- Approval route type signature accepts both query and body parameters

## [0.2.0] - 2026-02-03

### Added

- **Docker support** - One-command install with `docker-compose up`
  - Multi-stage Dockerfile with non-root user
  - Health checks and volume mounts
  - Demo mode for easy testing
- **TypeScript client** - Reusable client library for agent integration
  - Generic `callTool()` method for any tool
  - Typed helpers for `shellExec()`, `filesWrite()`, `httpRequest()`
  - Health check and configuration options
- **OpenClaw integration** - Skill package for OpenClaw AI assistant
  - `gk_exec`, `gk_write`, `gk_http` tool wrappers
  - SKILL.md manifest for skill discovery
- **Live integration tests** - End-to-end validation against running Gatekeeper
  - Tests all decision types (allow, approve, deny)
  - Verifies SSRF protection at execution time
- **Documentation guides**
  - `docs/POLICY_GUIDE.md` - Policy writing tutorial with recipes
  - `docs/APPROVALS.md` - Approval workflow and troubleshooting
  - `docs/AUDIT_LOGS.md` - Audit log reference and querying

### Changed

- README reorganized with better documentation navigation
- ESLint and Prettier configured for consistent code style

## [0.1.0] - 2026-01-31

Initial public release.

### Added

- **Core gatekeeper service** - Policy-based tool execution with ALLOW/APPROVE/DENY decisions
- **Tool executors**
  - `shell.exec` - Shell command execution with cwd restrictions and timeout caps
  - `files.write` - File writing with path allowlists and extension denylists
  - `http.request` - HTTP requests with SSRF protection (DNS resolution + IP range blocking)
- **Approval system**
  - HMAC-signed approval tokens (tamper-proof)
  - Single-use approvals (replay prevention)
  - Time-limited approvals (1 hour default expiry)
  - Pluggable approval providers (local, Slack, Runestone Cloud)
- **Policy engine**
  - YAML-based policy configuration
  - Per-tool decision rules
  - Pattern-based deny rules (regex)
  - Path and domain allowlists/denylists
- **Audit logging**
  - Append-only JSONL audit logs
  - Daily log rotation
  - Policy hash inclusion for forensics
  - Secret redaction
  - Pluggable audit sinks (JSONL, Runestone Cloud)
- **Security features**
  - Input validation with Zod schemas
  - SSRF protection via IP range blocking
  - Request signing for approval links
- **Documentation**
  - README with quickstart and examples
  - ARCHITECTURE.md with system design
  - AGENT_GOVERNANCE.md with governance patterns

### Security

- All approval tokens are HMAC-SHA256 signed
- Approval links are single-use and time-limited
- SSRF protection blocks access to private IP ranges
- Secrets are redacted from audit logs

[Unreleased]: https://github.com/Runestone-Labs/gatekeeper/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/Runestone-Labs/gatekeeper/compare/v0.3.2...v0.5.0
[0.3.2]: https://github.com/Runestone-Labs/gatekeeper/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/Runestone-Labs/gatekeeper/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Runestone-Labs/gatekeeper/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Runestone-Labs/gatekeeper/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Runestone-Labs/gatekeeper/releases/tag/v0.1.0
