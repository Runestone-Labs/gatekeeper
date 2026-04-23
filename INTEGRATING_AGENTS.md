# Integrating Agents with Gatekeeper

## Philosophy

Runestone Gatekeeper is intentionally agent-agnostic.

It does not embed or depend on any specific agent framework. Instead, it
enforces a boundary at the point where agents attempt to interact with
real systems (shell, filesystem, network, etc.).

In principle, agent runtimes that support tool abstraction or function calls
could integrate with Gatekeeper by routing those calls through the Gatekeeper
API. This integration pattern is conceptual—production use may require
additional work depending on your agent framework and requirements.

## What This Repository Does

- Enforces policy decisions at execution time
- Provides ALLOW / APPROVE / DENY semantics
- Handles human approval workflows
- Logs all decisions to an audit trail
- Demonstrates failure modes clearly via demos

## What This Repository Does Not Do

- Embed or import agent frameworks
- Provide agent orchestration or lifecycle management
- Handle multi-tenant policy distribution
- Manage long-running agent state
- Store durable audit logs for compliance

These capabilities require a control plane and are out of scope for this
enforcement layer.

## Integration Pattern

The integration pattern is simple:

1. Your agent decides to call a tool (e.g., `shell.exec`)
2. Instead of executing directly, the agent calls Gatekeeper's API
3. Gatekeeper evaluates policy and returns a decision
4. If ALLOW: the tool executes and returns results
5. If APPROVE: the agent waits for human approval, then retries
6. If DENY: the agent receives an error and must adapt

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   Agent     │────▶│  Gatekeeper  │────▶│   Tools     │
│  (any)      │◀────│  (this repo) │◀────│  (real)     │
└─────────────┘     └──────────────┘     └─────────────┘
```

Requests must include `actor.role` so Gatekeeper can apply principal policies.

The agent does not need to "know" about governance logic. It simply
routes tool calls through an HTTP endpoint.

### Idempotency and Capabilities

- **Idempotency**: Include `idempotencyKey` to make retries safe. Gatekeeper will replay the original decision/response and avoid double execution.
- **Capability tokens**: Use `capabilityToken` to pre-authorize an approve decision without manual approval. Tokens are scoped to tool + args hash.

## Example Adapter

See `examples/agent-adapter.ts` for an illustrative sketch of how an
agent framework might route tool calls through Gatekeeper. This example
is intentionally incomplete and not production-ready.

---

## Practical Integration Patterns

The patterns below come up in real integrations. Each is independent — adopt
what fits.

### Role-per-agent via principals

Every request carries `actor.role`. Policy files can declare per-role rules
that compose with tool-level rules, so multiple agents sharing one gatekeeper
can have different capability sets.

```yaml
# policy.yaml
principals_file: ./principals.yaml

tools:
  shell.exec:
    decision: approve
    max_timeout_ms: 30000
  http.request:
    decision: allow
```

```yaml
# principals.yaml
researcher:
  allowedTools: [http.request, memory.query, memory.episode]
  denyPatterns:
    - "(api\\.openai\\.com|anthropic\\.com)/.*keys"

ops:
  allowedTools: [shell.exec, files.write, http.request]
  requireApproval: [shell.exec]

readonly:
  allowedTools: [memory.query, http.request]
```

Agents identify their role at request time:

```typescript
const gk = new GatekeeperClient({
  baseUrl: 'http://127.0.0.1:3847',
  agentName: 'literature-scanner',
  agentRole: 'researcher',  // picks up principals.researcher.*
});
```

**Evaluation order:** principal `allowedTools` is checked first — if the role
can't call this tool at all, it's denied before tool-level rules run.
Principal `denyPatterns` are unioned with the tool's `deny_patterns`.
Principal `requireApproval` upgrades an `allow` to `approve` for that role.

### Taint propagation

When tool output feeds back into the agent — especially content from URLs,
emails, or user-supplied documents — mark it as tainted. Downstream calls
that act on tainted data should pass the label through.

```typescript
// 1. Agent fetches external content
const page = await gk.httpRequest({ url: targetUrl, method: 'GET' });

// 2. Content becomes input to the next tool call — mark origin + taint
const summary = await gk.callTool('some.llm.tool', { prompt: page.result.body }, {
  origin: 'external_content',
  taint: ['external', 'web'],
  contextRefs: [{ type: 'url', id: targetUrl }],
});

// 3. If the LLM then asks to run a shell command based on that content,
//    forward the taint — policy can deny `shell.exec` when taint includes
//    'external'.
await gk.shellExec({ command: suggestedCommand }, {
  origin: 'model_inferred',
  taint: ['external', 'web'],          // forwarded
  contextRefs: [{ type: 'url', id: targetUrl }],
});
```

Policy can match on taint:

```yaml
# In principals.yaml
ops:
  denyPatterns:
    - "\"taint\":\\[.*\"external\""  # deny shell commands derived from external content
```

The `origin` field (`user_direct` | `model_inferred` | `external_content` |
`background_job`) gives policy another lever: a human explicitly asking to
run `rm -rf ./tmp/build` is different from a model inferring it from a README.

### Capability tokens: pre-approved execution

If a tool's policy decision is `approve`, every call requires manual
approval. Capability tokens let you pre-authorize a specific call
(tool + exact args) without sitting in the approval loop.

**When to use:** automated retries of known-safe operations, workflows that
prompt once and then batch-execute, scheduled jobs that shouldn't require
a human on-call.

Mint a token out-of-band:

```bash
# Write the exact args you want to pre-authorize
cat > /tmp/args.json <<'EOF'
{"command": "git pull --ff-only", "cwd": "/opt/app"}
EOF

# Mint a 1-hour token scoped to tool + args hash + role
npm run capability:create -- \
  --tool shell.exec \
  --args /tmp/args.json \
  --ttl 3600 \
  --actor-role deploy-bot
```

Include the token in the request:

```typescript
await gk.callTool('shell.exec', { command: 'git pull --ff-only', cwd: '/opt/app' }, {
  capabilityToken: process.env.DEPLOY_CAP_TOKEN,
});
```

The server verifies:

- Token signature (HMAC-SHA256 with `GATEKEEPER_SECRET`)
- `tool` matches
- `argsHash` matches (any arg change invalidates the token)
- `actorRole` matches (if the token was minted with one)
- `expiresAt` is in the future

A valid token converts the `approve` decision to `allow` and adds a
`capability_token` risk flag to the audit entry — you can still tell from
the log that it was pre-authorized rather than manually approved.

### Idempotency for retries

Networks fail. The same tool call arriving twice should not execute twice.
Pass `idempotencyKey` explicitly when retrying:

```typescript
const key = `daily-backup-${new Date().toISOString().slice(0, 10)}`;

try {
  await gk.callTool('shell.exec', { command: 'pg_dump ...' }, { idempotencyKey: key });
} catch (networkError) {
  // Same key + same args → returns original response, does not re-execute
  await gk.callTool('shell.exec', { command: 'pg_dump ...' }, { idempotencyKey: key });
}
```

Collisions are detected:

- **Same key, same args** → cached response returned (HTTP 200/202/403)
- **Same key, different args** → 409 `IDEMPOTENCY_KEY_CONFLICT`

Args are compared by SHA-256 over the canonicalized (sorted-key) JSON, so
reordered object fields don't falsely collide.

### Dry-run for policy inspection

Set `dryRun: true` to get the policy decision without executing. Useful for
preflight checks in UIs, CI policy linting, and debugging deny reasons:

```typescript
const preview = await gk.callTool('shell.exec', { command: userInput }, {
  dryRun: true,
});

if (preview.decision === 'deny') {
  showWarning(preview.humanExplanation, preview.remediation);
}
```

Dry-run requests *are* logged to the audit trail (with
`decision: dryRun: true`) so you can audit what callers were testing.

### Wiring specific agent frameworks

The gatekeeper exposes one HTTP surface — `POST /tool/:toolName` — so any
agent that can be configured to call an HTTP endpoint for tool execution can
be wired up. Some concrete patterns:

- **OpenClaw** — the `integrations/openclaw/` directory ships a skill package
  with `gk_exec`, `gk_write`, `gk_http` tool wrappers. Drop the skill into
  your OpenClaw install and point `GATEKEEPER_URL` at the server.
- **MCP servers** — wrap the gatekeeper client in an MCP tool handler.
  Each MCP tool becomes a thin adapter that calls `gk.callTool()` with the
  appropriate role and taint metadata.
- **Claude Code hooks** — use a pre-tool hook that intercepts Bash/Write
  calls and routes them through the gatekeeper, denying locally if the
  gatekeeper denies. The `PreToolUse` hook in `.claude/settings.json` can
  shell out to `curl` against the gatekeeper API.
- **Custom TypeScript agents** — `npm install @runestone-labs/gatekeeper-client`
  and use it directly.

The common pattern across all of these: the agent framework's tool-execution
seam is the integration point. Instead of executing the tool, send the
request to the gatekeeper; only execute on an `allow` response.

---

## Production Agents

This repository focuses on the enforcement boundary itself.

Testing and operating Gatekeeper with long-running or production agents
is an area we expect to evolve alongside a hosted control plane. Production
use typically requires centralized approvals, durable audit storage, and
policy distribution—capabilities that are out of scope for this repository.

See [RUNESTONE_CLOUD.md](RUNESTONE_CLOUD.md) for the OSS/Cloud boundary.
