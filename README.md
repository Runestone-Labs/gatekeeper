# Runestone Agent Gatekeeper

[![CI](https://github.com/Runestone-Labs/gatekeeper/actions/workflows/ci.yml/badge.svg)](https://github.com/Runestone-Labs/gatekeeper/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

A policy-based gatekeeper service that sits between AI agents and real-world tools (shell, HTTP, filesystem), enforcing approvals, denials, and audit logging.

## What Problem This Solves

AI agents need to execute actions in the real world: running shell commands, writing files, making HTTP requests. Without guardrails, an agent can accidentally (or adversarially) execute dangerous operations.

The Gatekeeper intercepts all tool requests and:
- **Allows** low-risk operations immediately
- **Denies** operations that match dangerous patterns
- **Requires human approval** for sensitive operations

All decisions are logged to an append-only audit trail.

## Threat Model

This gatekeeper protects against:

1. **Accidental damage**: Agent runs `rm -rf /` or overwrites critical files
2. **Prompt injection execution**: Malicious content tricks agent into dangerous actions
3. **Exfiltration**: Agent sends secrets to external services
4. **SSRF attacks**: Agent accesses internal services via HTTP

This gatekeeper does NOT protect against:

- Malicious operator with access to the policy file
- Attacks on the gatekeeper service itself
- Social engineering of the human approver
- Denial of service (no rate limiting)

## Quick Start with Docker

The fastest way to try Gatekeeper:

```bash
git clone https://github.com/Runestone-Labs/gatekeeper.git
cd gatekeeper
docker-compose up
```

Gatekeeper is now running at http://localhost:3847 with demo mode enabled.

Test it:
```bash
# This will be DENIED (dangerous pattern)
curl -X POST http://localhost:3847/tool/shell.exec \
  -H "Content-Type: application/json" \
  -d '{"requestId":"550e8400-e29b-41d4-a716-446655440001","actor":{"type":"agent","name":"test"},"args":{"command":"rm -rf /"}}'

# This will be ALLOWED
curl -X POST http://localhost:3847/tool/http.request \
  -H "Content-Type: application/json" \
  -d '{"requestId":"550e8400-e29b-41d4-a716-446655440002","actor":{"type":"agent","name":"test"},"args":{"url":"https://httpbin.org/get","method":"GET"}}'
```

To customize policy, edit `policy.yaml` and restart:
```bash
docker-compose restart
```

For manual installation without Docker, see below.

## Quick Start (Manual)

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

```bash
# Required: Secret for HMAC signing (at least 32 characters)
export GATEKEEPER_SECRET="your-secret-key-at-least-32-chars-long"

# Provider selection (optional)
export APPROVAL_PROVIDER=local   # local | slack | runestone (default: local)
export AUDIT_SINK=jsonl          # jsonl | runestone (default: jsonl)
export POLICY_SOURCE=yaml        # yaml | runestone (default: yaml)

# Optional: Slack webhook for approval notifications (when using slack provider)
export SLACK_WEBHOOK_URL="https://hooks.slack.com/services/..."

# Optional: Custom port (default: 3847)
export GATEKEEPER_PORT=3847

# Optional: Base URL for approval links
export BASE_URL="http://localhost:3847"
```

### 3. Create Policy File

```bash
cp policy.example.yaml policy.yaml
# Edit policy.yaml to match your requirements
```

### 4. Start the Server

```bash
npm start
# Or for development with auto-reload:
npm run dev
```

## Demo (2 minutes)

See all three decision types in action:

```bash
# Install dependencies
npm install

# Set a demo secret (or use your own)
export GATEKEEPER_SECRET="demo-secret-at-least-32-characters-long"

# Run the demo
npm run demo
```

The demo runs through:
1. **DENY** - Dangerous command (`rm -rf /`) is blocked
2. **APPROVE** - Safe command (`ls -la`) requires approval, then auto-approved
3. **ALLOW** - HTTP request executes immediately

### Recording

```bash
# Record with asciinema (creates demo.cast)
npm run demo:record

# Playback
asciinema play demo.cast

# Create GIF/MP4 with VHS (requires: brew install vhs)
npm run demo:gif
```

### Outputs

- `demo.cast` - Terminal recording (asciinema format)
- `demo.gif` - Animated GIF for sharing
- `demo.mp4` - Video file
- `data/audit/YYYY-MM-DD.jsonl` - Audit log with all demo actions

## Provider Architecture

The gatekeeper uses a pluggable provider system for flexibility:

### Approval Providers
- **local** (default): Logs approval URLs to console
- **slack**: Sends interactive approval requests via Slack webhook
- **runestone**: Enterprise control plane (coming soon)

### Audit Sinks
- **jsonl** (default): Writes to daily JSONL files in `data/audit/`
- **runestone**: Stream to cloud for search and compliance (coming soon)

### Policy Sources
- **yaml** (default): Load from local YAML file
- **runestone**: Managed policies with version control (coming soon)

## Example Requests

### Execute a Tool (Allow Decision)

```bash
curl -X POST http://localhost:3847/tool/http.request \
  -H "Content-Type: application/json" \
  -d '{
    "requestId": "550e8400-e29b-41d4-a716-446655440000",
    "actor": {
      "type": "agent",
      "name": "my-agent",
      "runId": "run-123"
    },
    "args": {
      "url": "https://api.example.com/data",
      "method": "GET"
    }
  }'
```

Response (200):
```json
{
  "decision": "allow",
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "success": true,
  "result": {
    "status": 200,
    "headers": {"content-type": "application/json"},
    "body": "{...}"
  }
}
```

### Execute a Tool (Approve Decision)

```bash
curl -X POST http://localhost:3847/tool/shell.exec \
  -H "Content-Type: application/json" \
  -d '{
    "requestId": "550e8400-e29b-41d4-a716-446655440001",
    "actor": {
      "type": "agent",
      "name": "my-agent"
    },
    "args": {
      "command": "ls -la /tmp"
    }
  }'
```

Response (202):
```json
{
  "decision": "approve",
  "reason": "Requires human approval",
  "requestId": "550e8400-e29b-41d4-a716-446655440001",
  "approvalId": "abc123...",
  "expiresAt": "2026-01-31T13:00:00.000Z",
  "message": "Approval required. Check local for approval links."
}
```

### Execute a Tool (Deny Decision)

```bash
curl -X POST http://localhost:3847/tool/shell.exec \
  -H "Content-Type: application/json" \
  -d '{
    "requestId": "550e8400-e29b-41d4-a716-446655440002",
    "actor": {
      "type": "agent",
      "name": "my-agent"
    },
    "args": {
      "command": "rm -rf /"
    }
  }'
```

Response (403):
```json
{
  "decision": "deny",
  "reason": "Denied: matches deny pattern \"rm -rf\"",
  "requestId": "550e8400-e29b-41d4-a716-446655440002"
}
```

### Health Check

```bash
curl http://localhost:3847/health
```

Response:
```json
{
  "version": "0.1.0",
  "policyHash": "sha256:abc123...",
  "uptime": 3600,
  "pendingApprovals": 2,
  "providers": {
    "approval": "local",
    "policy": "yaml"
  }
}
```

## Policy Configuration

See `policy.example.yaml` for a complete example.

```yaml
tools:
  shell.exec:
    decision: approve           # allow | approve | deny
    deny_patterns:
      - "rm -rf"               # Regex patterns to block
    allowed_cwd_prefixes:
      - "/tmp/"                # Allowed working directories
    max_output_bytes: 1048576
    max_timeout_ms: 30000

  files.write:
    decision: approve
    allowed_paths:
      - "/tmp/"
    deny_extensions:
      - ".env"
    max_size_bytes: 10485760

  http.request:
    decision: allow
    allowed_methods: ["GET", "POST"]
    deny_domains:
      - "pastebin.com"
    deny_ip_ranges:            # SSRF protection
      - "127.0.0.0/8"
      - "169.254.0.0/16"
    max_body_bytes: 1048576
```

For a complete policy writing tutorial, see [docs/POLICY_GUIDE.md](docs/POLICY_GUIDE.md).

## Approval Flow

1. Agent submits tool request
2. Gatekeeper evaluates against policy
3. If `approve`: Creates pending approval, sends notification via configured provider
4. Human clicks Approve or Deny link
5. If Approved: Tool executes, result returned
6. All actions logged to audit trail

Approval links are:
- HMAC-signed (tamper-proof)
- Single-use (prevents replay)
- Time-limited (1 hour expiry)

For a detailed approval workflow guide, see [docs/APPROVALS.md](docs/APPROVALS.md).

## Audit Logs

All requests are logged via the configured audit sink. Default (jsonl) writes to `data/audit/YYYY-MM-DD.jsonl`:

```json
{
  "timestamp": "2026-01-31T12:00:00.000Z",
  "requestId": "550e8400-...",
  "tool": "shell.exec",
  "decision": "approve",
  "actor": {"type": "agent", "name": "my-agent"},
  "argsSummary": "{\"command\":\"ls -la\"}",
  "riskFlags": [],
  "policyHash": "sha256:abc123...",
  "gatekeeperVersion": "0.1.0"
}
```

Logs are:
- Append-only (never modified)
- One file per day (easy rotation)
- Include policy hash (for forensics)
- Secrets are redacted

For a complete audit log reference with querying examples, see [docs/AUDIT_LOGS.md](docs/AUDIT_LOGS.md).

## Using with Real Agents

Gatekeeper is designed to be agent-agnostic. It does not embed or depend on any specific agent framework.

In principle, any agent that can route tool calls over HTTP could integrate with Gatekeeper. See [INTEGRATING_AGENTS.md](INTEGRATING_AGENTS.md) for the conceptual integration pattern.

This repository focuses on the enforcement boundary itself. Production agent integration is an area we expect to evolve alongside a hosted control plane.

## Enterprise Control Plane

**Runestone Control Plane** provides:

- **Managed Policies**: Version-controlled policy configuration with templates
- **Searchable Audit**: Full-text search across all audit logs with compliance exports
- **Web-based Approvals**: Modern approval UI with mobile notifications
- **Team Workflows**: Approval routing, escalation, and delegation

Contact: enterprise@runestone.dev

## Security Decisions

| Feature | Implementation | Rationale |
|---------|----------------|-----------|
| Approval signing | HMAC-SHA256 of full payload | Prevents parameter tampering |
| Single-use approvals | Status field + atomic update | Prevents replay attacks |
| Expiry | 1 hour default | Limits approval window |
| Input validation | Zod with `.strict()` | Rejects unknown fields |
| Shell constraints | cwd allowlist, timeout caps | Limits blast radius |
| SSRF protection | DNS resolution + IP checks | Blocks internal access |
| Audit logging | Append-only via pluggable sink | Tamper-evident trail |

## Development

```bash
# Type check
npm run typecheck

# Run tests
npm run test:run

# Run with auto-reload
npm run dev

# Run production
npm start
```

## Memory System (Optional)

When `DATABASE_URL` is configured with PostgreSQL + Apache AGE, Gatekeeper provides graph-based memory tools:

| Tool | Description |
|------|-------------|
| `memory.upsert` | Create/update entities (people, projects, concepts) |
| `memory.link` | Create relationships between entities |
| `memory.query` | Query entities and traverse relationships |
| `memory.episode` | Log decisions, events, and observations |

```bash
# Create an entity
curl -X POST http://localhost:3847/tool/memory.upsert \
  -H "Content-Type: application/json" \
  -d '{"requestId":"...","actor":{"type":"agent","name":"test"},"args":{"type":"person","name":"Alice"}}'

# Link two entities
curl -X POST http://localhost:3847/tool/memory.link \
  -H "Content-Type: application/json" \
  -d '{"requestId":"...","actor":{"type":"agent","name":"test"},"args":{"sourceId":"<id1>","targetId":"<id2>","relation":"knows"}}'
```

See [docs/MEMORY.md](docs/MEMORY.md) for setup and full API reference.

## Documentation

### Guides
- [docs/MEMORY.md](docs/MEMORY.md) - Graph-based memory system setup and usage
- [docs/POLICY_GUIDE.md](docs/POLICY_GUIDE.md) - How to write and customize policies
- [docs/APPROVALS.md](docs/APPROVALS.md) - Approval workflow details and troubleshooting
- [docs/AUDIT_LOGS.md](docs/AUDIT_LOGS.md) - Audit log format and querying

### Reference
- [THREAT_MODEL.md](THREAT_MODEL.md) - Security assumptions and non-goals
- [INTEGRATING_AGENTS.md](INTEGRATING_AGENTS.md) - Using Gatekeeper with real agents
- [RUNESTONE_CLOUD.md](RUNESTONE_CLOUD.md) - OSS vs Cloud architecture

### Contributing
- [CONTRIBUTING.md](CONTRIBUTING.md) - How to contribute
- [SECURITY.md](SECURITY.md) - Security policy and vulnerability reporting
- [GOVERNANCE.md](GOVERNANCE.md) - Project governance
- [CHANGELOG.md](CHANGELOG.md) - Release history

## License

Apache-2.0 - See [LICENSE](LICENSE) for details.
