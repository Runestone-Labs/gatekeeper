# Threat Model

This document describes the security assumptions, trust boundaries, and threat
mitigations for Runestone Gatekeeper.

## Overview

Runestone Gatekeeper is a policy enforcement layer that sits between AI agents
and real-world tools (shell, filesystem, HTTP). It intercepts tool requests,
evaluates them against policy, and either allows, denies, or requires human
approval before execution.

## Deployment Assumptions

The gatekeeper is designed for **local deployment**:

- Runs on localhost or within a private network
- Not exposed to the public internet
- The human operator has physical or SSH access to the machine
- The policy file is controlled by the operator

If you need external access to approval endpoints, place the gatekeeper behind
an authenticated reverse proxy.

## Trust Boundaries

```
┌─────────────────────────────────────────────────────────────┐
│                     TRUSTED ZONE                            │
│  ┌─────────────┐    ┌──────────────┐    ┌───────────────┐  │
│  │   Operator  │    │  Policy File │    │   Gatekeeper  │  │
│  │  (Human)    │───▶│  (YAML)      │───▶│   (This Code) │  │
│  └─────────────┘    └──────────────┘    └───────┬───────┘  │
│                                                  │          │
└──────────────────────────────────────────────────┼──────────┘
                                                   │
                                           ENFORCEMENT
                                           BOUNDARY
                                                   │
┌──────────────────────────────────────────────────┼──────────┐
│                    UNTRUSTED ZONE                │          │
│  ┌─────────────┐                                 ▼          │
│  │  AI Agent   │◀────────────────────────────────┘          │
│  │  (Claude,   │                                            │
│  │   GPT, etc) │───▶ Tool Requests                          │
│  └─────────────┘                                            │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Trusted

- **Operator**: Controls policy, environment, and has access to approve/deny
- **Policy file**: Defines what is allowed, denied, or requires approval
- **Gatekeeper code**: This repository (assumed to be uncompromised)
- **Approval provider**: Local console, Slack webhook, or Runestone Cloud

### Untrusted

- **AI Agent**: May be influenced by prompt injection or adversarial inputs
- **Agent inputs**: User prompts, retrieved documents, tool outputs
- **External services**: APIs the agent interacts with

## Threats Mitigated

### 1. Accidental Damage

**Threat**: Agent runs destructive commands like `rm -rf /` or overwrites
critical system files.

**Mitigation**:
- Deny patterns block known-dangerous commands
- Path allowlists restrict file operations
- Working directory restrictions for shell commands
- Human approval required for sensitive operations

### 2. Prompt Injection Execution

**Threat**: Malicious content in documents or user input tricks the agent
into executing harmful actions.

**Mitigation**:
- Policy evaluation is independent of agent reasoning
- Deny patterns catch common attack payloads
- Human-in-the-loop for approval decisions
- Audit trail for forensics

### 3. Data Exfiltration

**Threat**: Agent sends sensitive data (secrets, source code) to external
services controlled by an attacker.

**Mitigation**:
- Domain denylists block known exfiltration targets
- HTTP method restrictions
- Request body size limits
- Audit logging of all HTTP requests

### 4. SSRF (Server-Side Request Forgery)

**Threat**: Agent accesses internal services (metadata endpoints, databases,
admin panels) via HTTP requests.

**Mitigation**:
- DNS resolution before request execution
- IP range blocking for private ranges:
  - `127.0.0.0/8` (localhost)
  - `10.0.0.0/8` (private)
  - `172.16.0.0/12` (private)
  - `192.168.0.0/16` (private)
  - `169.254.0.0/16` (link-local, cloud metadata)
- Configurable deny lists for specific domains

### 5. Approval Bypass

**Threat**: Attacker forges or replays approval tokens to execute
unapproved actions.

**Mitigation**:
- HMAC-SHA256 signatures on approval tokens
- Full request payload included in signature (prevents parameter tampering)
- Single-use tokens (status field prevents replay)
- Time-limited expiry (1 hour default)

### 6. Audit Evasion

**Threat**: Attacker attempts to hide their actions by tampering with
or circumventing audit logs.

**Mitigation**:
- Append-only log files
- Logging occurs before execution (intent captured even if execution fails)
- Policy hash included (detect policy changes)
- Secrets redacted (safe to retain logs)

## Threats NOT Mitigated

The following are explicitly out of scope:

### Malicious Operator

If the operator (person with access to policy file and environment) is
malicious, they can:
- Modify policy to allow anything
- Access the GATEKEEPER_SECRET
- Directly execute commands without the gatekeeper

**Rationale**: The operator is in the trusted zone by design.

### Attacks on the Gatekeeper Itself

If an attacker can:
- Modify the gatekeeper source code
- Access the process memory
- Intercept localhost traffic

...they can bypass all protections.

**Rationale**: Protect the gatekeeper deployment with standard server security.

### Social Engineering of Approvers

If an attacker can convince a human to approve a malicious request, the
gatekeeper will execute it.

**Mitigation**: Train approvers, provide clear context in approval requests.

### Denial of Service

The gatekeeper does not implement:
- Rate limiting
- Request queuing
- Resource quotas

An agent can spam requests to exhaust resources.

**Rationale**: Local deployment assumption; add rate limiting at the
reverse proxy layer if needed.

### Sophisticated Evasion

Clever encoding, obfuscation, or multi-step attacks may bypass deny patterns.

**Mitigation**: Defense in depth. The gatekeeper is one layer; combine with
sandboxing, network policies, and monitoring.

## Security Controls Summary

| Control | Implementation | Bypasses |
|---------|----------------|----------|
| Deny patterns | Regex matching | Encoding, obfuscation |
| Path allowlists | Prefix matching | Symlinks (if not resolved) |
| SSRF blocking | DNS + IP check | DNS rebinding (mitigated by resolution timing) |
| Approval signing | HMAC-SHA256 | Secret compromise |
| Single-use approvals | Status field | Race conditions (mitigated by atomic updates) |
| Audit logging | Append-only JSONL | Filesystem access |

## Recommendations for Deployers

1. **Keep the gatekeeper on localhost** - Do not expose to the internet
2. **Use a strong secret** - At least 32 random characters
3. **Review deny patterns** - Customize for your environment
4. **Train approvers** - Ensure they understand what they're approving
5. **Monitor audit logs** - Set up alerts for denied requests
6. **Layer defenses** - Combine with containers, network policies, EDR

## Related Documents

- [SECURITY.md](SECURITY.md) - Vulnerability reporting
- [README.md](README.md) - Security Decisions table
- [ARCHITECTURE.md](ARCHITECTURE.md) - System design
