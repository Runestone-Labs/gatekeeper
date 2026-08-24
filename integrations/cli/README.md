# `@runestone-labs/gatekeeper`

The self-serve CLI for Runestone Gatekeeper. It previews every client
configuration change, creates timestamped backups before applying one, and can
restore the most recent patch.

## Install

```bash
npm install --global @runestone-labs/gatekeeper
```

You can also run a single command without installing globally:

```bash
npx -y @runestone-labs/gatekeeper --help
```

## Usage

```bash
gatekeeper init --client claude-code
gatekeeper init --client claude-code --apply
gatekeeper doctor
gatekeeper verify ./data/audit
gatekeeper init --revert
```

Cloud connection remains an experimental dogfood flow while the hosted team layer validates demand.
The public Cloud endpoint is not generally available. Join the validation funnel at
https://gatekeeper.runestonelabs.io/cloud-beta before depending on `connect`.

- `init` previews reversible Claude Code, OpenClaw, and MCP configuration patches.
- `connect` uses browser device authorization and writes a scoped token with mode `0600` when an explicitly provisioned test control plane is available.
- `doctor` reports actual routed tool coverage, fail-closed posture, budgets, Cloud delivery, and receipt integrity.
- `verify` independently checks the local SHA-256 receipt chain.
- `disconnect` revokes Cloud access without turning off local enforcement.

Gatekeeper only controls actions actually routed through it. `doctor` lists known native-tool gaps rather than claiming complete coverage.

Full documentation and source: https://github.com/Runestone-Labs/gatekeeper
