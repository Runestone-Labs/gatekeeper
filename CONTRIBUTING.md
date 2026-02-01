# Contributing to Runestone Gatekeeper

Thank you for your interest in contributing.

Runestone Gatekeeper is an intentionally small, security-focused
reference implementation for enforcing policy and approval boundaries
between AI agents and real-world tools.

Our primary goals are:
- correctness
- clarity
- auditability
- secure defaults

We are not aiming to be a full agent framework or platform.

## What we welcome

We actively welcome contributions in these areas:

### Bug fixes and hardening
- correctness issues
- security edge cases
- improved validation
- better test coverage

### Providers and integrations
Gatekeeper is designed to be extended via providers.

Good contribution examples:
- new approval providers (e.g. email, Teams)
- new audit sinks (e.g. S3, Splunk, Datadog)
- alternative policy sources

Providers should be:
- optional
- well-isolated
- minimally invasive to the core

### Documentation improvements
- clearer threat model explanations
- better examples
- deployment warnings
- README clarity

### Issues and design feedback
Well-described issues and thoughtful design feedback are extremely valuable,
even if you're not submitting code.

## What we are cautious about

Because Gatekeeper enforces security boundaries, we are intentionally
conservative about changes to the core runtime.

Please open an issue before submitting PRs that:
- add new tools to the core
- change policy semantics
- introduce complex configuration or DSLs
- significantly refactor execution or approval logic

These changes may be out of scope for this project.

## Development setup

### Prerequisites
- Node.js 20 or later
- npm

### Getting started

```bash
# Clone and install
git clone https://github.com/Runestone-Labs/gatekeeper.git
cd gatekeeper
npm install

# Set up environment
cp .env.example .env
# Edit .env and set GATEKEEPER_SECRET to a 32+ character string

# Run tests
npm run test:run

# Type check
npm run typecheck

# Start development server
npm run dev
```

### Running tests

```bash
# Run all tests
npm run test:run

# Run tests in watch mode
npm test

# Run with coverage
npm run test:coverage
```

## Development workflow

- Fork the repo
- Create a feature branch
- Add tests for any behavior changes
- Ensure all tests pass (`npm run test:run`)
- Ensure types check (`npm run typecheck`)
- Open a PR with a clear explanation of intent and risk

## Security

If you believe you've found a security vulnerability, please follow
the instructions in [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Code of conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md).
