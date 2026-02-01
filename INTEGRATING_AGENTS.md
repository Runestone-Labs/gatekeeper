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

The agent does not need to "know" about governance logic. It simply
routes tool calls through an HTTP endpoint.

## Example Adapter

See `examples/agent-adapter.ts` for an illustrative sketch of how an
agent framework might route tool calls through Gatekeeper. This example
is intentionally incomplete and not production-ready.

## Production Agents

This repository focuses on the enforcement boundary itself.

Testing and operating Gatekeeper with long-running or production agents
is an area we expect to evolve alongside a hosted control plane. Production
use typically requires centralized approvals, durable audit storage, and
policy distribution—capabilities that are out of scope for this repository.

See [RUNESTONE_CLOUD.md](RUNESTONE_CLOUD.md) for the OSS/Cloud boundary.
