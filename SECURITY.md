# Security Policy

## Reporting a Vulnerability

If you believe you have found a security vulnerability in Runestone Gatekeeper,
please report it responsibly.

**Email:** evan@runestonelabs.io

**Please include:**
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested fixes (optional)

**Response timeline:**
- Acknowledgment within 48 hours
- Initial assessment within 7 days
- Fix timeline communicated based on severity

## Scope

The following are in scope for security reports:

- Policy bypass (executing denied actions)
- Authentication/authorization issues in approval flow
- HMAC signature bypass or forgery
- SSRF protection bypass
- Injection vulnerabilities (command injection, path traversal)
- Audit log tampering or evasion
- Secrets exposure in logs or responses

## Out of Scope

The following are out of scope:

- Denial of service (no rate limiting is implemented by design)
- Social engineering of human approvers
- Attacks requiring access to the policy file or environment variables
- Issues in dependencies (report these upstream)
- Self-XSS or issues requiring physical access

## Deployment Warning

**This is a local enforcement layer. Do not expose the gatekeeper to the public internet.**

The gatekeeper is designed to run on localhost or within a private network,
mediating between a local AI agent and local/remote tools. It does not implement:

- Rate limiting
- DDoS protection
- Public-facing authentication
- TLS termination (use a reverse proxy if needed)

If you need to expose approval endpoints externally, place the gatekeeper
behind an authenticated reverse proxy.

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | Yes                |

We will backport security fixes to supported versions.

## Security Design

For details on the security architecture and threat model, see:

- [README.md](README.md) - Security Decisions table
- [THREAT_MODEL.md](THREAT_MODEL.md) - Detailed threat analysis
