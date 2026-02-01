# Project Governance

## Maintainers

The following individuals are responsible for maintaining this project:

| Name | GitHub | Role |
|------|--------|------|
| Evan Vandegriff | @evanvandegriff | Lead Maintainer |

## Decision Making

### Day-to-day decisions

For routine decisions (bug fixes, minor improvements, documentation updates),
maintainers use **lazy consensus**: if no objections are raised within a
reasonable time, the change proceeds.

### Significant decisions

For significant changes (new features, API changes, security-sensitive code),
maintainers will:

1. Open an issue describing the proposed change
2. Allow time for community feedback
3. Make the final decision, documenting rationale

The lead maintainer serves as BDFL (Benevolent Dictator For Life) for
tie-breaking and final decisions when consensus cannot be reached.

## Contributions

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

All contributions are subject to review by maintainers. We prioritize:
- Security correctness
- Code clarity
- Test coverage
- Documentation

## Releases

### Versioning

This project follows [Semantic Versioning](https://semver.org/):

- **MAJOR**: Breaking changes to the API or policy format
- **MINOR**: New features, backward-compatible
- **PATCH**: Bug fixes, backward-compatible

While in 0.x, minor versions may include breaking changes.

### Release process

1. Update CHANGELOG.md with release notes
2. Update version in package.json
3. Create a signed git tag
4. Push tag to trigger release workflow
5. Publish release notes on GitHub

### Cadence

Releases are made as needed. There is no fixed schedule.
Security fixes are released as soon as possible.

## Roadmap

The project roadmap is tracked via GitHub Issues and the pinned
"Roadmap" issue when available.

## Communication

- **Issues**: Bug reports, feature requests, design discussions
- **Pull Requests**: Code contributions and reviews
- **Security**: See [SECURITY.md](SECURITY.md) for vulnerability reporting

## Changes to Governance

This governance document may be updated by the lead maintainer.
Significant changes will be announced via a GitHub issue.
