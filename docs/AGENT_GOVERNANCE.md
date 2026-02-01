# Agent Governance Is a Control Plane Problem

## The New Boundary

AI agents are crossing a boundary that software hasn't crossed before: the tool boundary.

Traditional software runs deterministic code. An API call does what the code says. A database query returns predictable results. The behavior is specified by the developer.

Agents are different. They decide at runtime which tools to call, with what arguments, in response to natural language input. The agent's behavior emerges from the interaction between:

- The model's training
- The system prompt
- User input (which may be adversarial)
- Tool availability
- Context from previous actions

This creates a new category of risk: **tool execution without deterministic intent**.

## Policy Is Not Safety

Many "agent safety" solutions stop at policy: deny patterns, allowlists, regex filters.

This is necessary but not sufficient.

Deny patterns catch known-bad patterns like `rm -rf` or `curl | sh`. But:

- Adversaries can obfuscate (`r''m -r''f`)
- Novel attacks have no pattern yet
- False positives block legitimate work
- Policy drift creates blind spots

Policy is a **filter**, not a **governor**.

A filter blocks bad inputs. A governor manages the entire lifecycle of an action, including:

- Who requested it
- Why it was requested
- Who approved it
- What actually happened
- What the result was

## The Governance Triad

Real governance requires three interlocking systems:

### 1. Policy (Before)

What *should* be allowed, denied, or escalated?

- Deny patterns for known-bad
- Allowlists for known-good
- Default-approve for unknown (human decides)

### 2. Approval (During)

Who decides when policy says "ask"?

- Human-in-the-loop for sensitive actions
- Tamper-proof approval links (signed, single-use, time-limited)
- Audit trail of approver identity

### 3. Audit (After)

What actually happened?

- Append-only log of all requests and outcomes
- Links decision to execution to result
- Policy hash at time of decision (for forensics)

Without all three, you have gaps:

| Missing | Gap |
|---------|-----|
| Policy only | No human oversight, no forensics |
| Approval only | No automation, no audit trail |
| Audit only | Reactive, not preventive |

## Execution Must Stay Local

A tempting architecture: send tool calls to a cloud service that executes them.

This is wrong for agents. Here's why:

**Latency**: Agents iterate. A shell command → parse output → next command loop needs milliseconds, not seconds. Round-trip to cloud breaks the loop.

**Secrets**: Tool execution touches local secrets: API keys, SSH keys, database credentials. Shipping these to a cloud service creates a new attack surface.

**Reliability**: Local execution works offline. Cloud execution doesn't.

**Trust boundary**: The gatekeeper should *decide*, not *execute*. Execution happens in the agent's environment, with the agent's permissions.

The right architecture:

```
Agent → Gatekeeper → Decision → Agent executes locally
                  ↓
            Control Plane (for approvals, audit, policy)
```

## Control Planes Win

Why does governance centralize?

**Consistency**: Multiple agents, one policy. One place to update deny patterns.

**Visibility**: One dashboard for all pending approvals. One search for all audit logs.

**Compliance**: SOC2, HIPAA, and SOX don't care about your local JSON files.

**Teams**: Approval routing, escalation, delegation. These require shared state.

Local gatekeepers are necessary for execution. Control planes are necessary for governance.

## The Runestone Model

Runestone separates these concerns cleanly:

**Local Runtime** (open source gatekeeper):
- Evaluates policy
- Executes tools
- Signs approvals
- Writes audit entries

**Cloud Control Plane** (Runestone Cloud):
- Stores and versions policies
- Routes approvals to the right humans
- Retains and indexes audit logs
- Manages team permissions

The local runtime is intentionally small: auditable, predictable, no dependencies beyond Node.js.

The control plane is where governance complexity lives: team workflows, compliance, search, alerting.

This separation means:

- Agents stay fast (local execution)
- Secrets stay local (no cloud execution)
- Governance stays centralized (cloud control plane)
- Open source stays maintainable (small surface area)

---

*Agent governance is not a feature. It's an architecture.*
