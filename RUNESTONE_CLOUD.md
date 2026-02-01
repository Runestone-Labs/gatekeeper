# Runestone Cloud

This document explains the relationship between the open source Runestone
Gatekeeper and Runestone Cloud, the commercial offering.

## Architecture Split

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         YOUR INFRASTRUCTURE                             │
│                                                                         │
│   ┌─────────────┐      ┌──────────────────────────────────────────┐    │
│   │  AI Agent   │─────▶│  Runestone Gatekeeper (OSS)              │    │
│   │             │      │                                          │    │
│   │  - Claude   │      │  - Policy evaluation                     │    │
│   │  - GPT      │      │  - Tool execution                        │    │
│   │  - Custom   │      │  - Local approval handling               │    │
│   └─────────────┘      │  - Audit logging                         │    │
│                        └──────────────────┬───────────────────────┘    │
│                                           │                             │
└───────────────────────────────────────────┼─────────────────────────────┘
                                            │ Optional
                                            │ (API calls)
                                            ▼
                    ┌───────────────────────────────────────────┐
                    │           RUNESTONE CLOUD                 │
                    │                                           │
                    │  - Managed policy distribution            │
                    │  - Web-based approval UI                  │
                    │  - Audit log aggregation & search         │
                    │  - Team workflows & escalation            │
                    │  - Compliance reporting                   │
                    └───────────────────────────────────────────┘
```

## What Stays Local (OSS)

The open source gatekeeper handles all **execution** locally:

| Capability | Description |
|------------|-------------|
| Policy evaluation | Decisions are made locally based on local policy |
| Tool execution | Shell, file, and HTTP operations run on your machine |
| Request signing | HMAC signatures generated with your secret |
| Local approvals | Console-based approval flow works offline |
| JSONL audit logs | Written to local disk |

**Your code and data never leave your infrastructure.**

## What the Cloud Adds

Runestone Cloud provides optional **governance infrastructure**:

| Capability | Description |
|------------|-------------|
| Policy management | Version-controlled policies with templates and inheritance |
| Approval UI | Web-based approval interface with mobile notifications |
| Audit aggregation | Centralized search across all gatekeepers |
| Team workflows | Approval routing, delegation, and escalation |
| Compliance | Audit exports, retention policies, access controls |
| Monitoring | Dashboards, alerts, anomaly detection |

## Why This Split?

### Execution stays local

- **Privacy**: Your agent's actions and data remain on your infrastructure
- **Latency**: No round-trip to cloud for every tool execution
- **Reliability**: Works offline; cloud outage doesn't block your agents
- **Security**: Secrets and sensitive operations never transit external networks

### Governance can centralize

- **Visibility**: See all agent activity across your organization
- **Consistency**: Distribute policies from a single source of truth
- **Collaboration**: Multiple team members can review and approve
- **Compliance**: Meet audit and retention requirements

## No Vendor Lock-in

The OSS gatekeeper is fully functional without Runestone Cloud:

- Use `APPROVAL_PROVIDER=local` for console-based approvals
- Use `AUDIT_SINK=jsonl` for local audit logs
- Use `POLICY_SOURCE=yaml` for local policy files

Runestone Cloud is additive. You can:
- Start with OSS only
- Add Cloud for specific capabilities
- Return to OSS-only at any time

All policy formats and audit schemas are documented and stable.

## Provider Configuration

To use Runestone Cloud providers, configure your environment:

```bash
# Approval provider
APPROVAL_PROVIDER=runestone
RUNESTONE_API_KEY=your-api-key
RUNESTONE_API_URL=https://api.runestone.dev

# Audit sink
AUDIT_SINK=runestone

# Policy source
POLICY_SOURCE=runestone
```

## Pricing and Access

Runestone Cloud is currently in private beta.

Contact: enterprise@runestone.dev

## Questions

For questions about the OSS/Cloud boundary or enterprise features,
open an issue or email enterprise@runestone.dev.
