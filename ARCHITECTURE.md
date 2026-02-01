# Why This Repo Is Intentionally Small

## Design Philosophy

This is a **reference implementation** of an agent gatekeeper, not a feature-complete product.

The core gatekeeper should remain:
- **Auditable**: Small enough for security review
- **Predictable**: No magic, no hidden behaviors
- **Extensible**: Via providers, not core changes

## What Belongs Here

- Policy evaluation logic
- Tool execution with constraints
- Approval flow mechanics
- Audit logging

## What Belongs in Providers / Control Planes

- Authentication and authorization
- Team workflows and escalation
- Searchable audit storage
- Policy versioning and templates
- Mobile notifications
- Rate limiting
- Metrics and alerting

## The Bright Line

**Local Runtime** (this repo):
- Evaluates policy
- Executes tools
- Signs approvals
- Writes audit entries

**Control Plane** (Runestone Cloud):
- Stores policies
- Routes approvals
- Retains audit logs
- Manages teams

Safety infrastructure gets worse when it grows uncontrolled.
