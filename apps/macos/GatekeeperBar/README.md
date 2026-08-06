# Gatekeeper Bar

Native macOS menu-bar approvals inbox for [Runestone Gatekeeper](../../..).

- Menu-bar badge with pending-hold count — a pull surface that can't fail silently
- Approve / Deny directly from the dropdown or from the notification's action buttons
- Today panel: calls, denies, real spend (via `/usage`), budget headroom (via `/budget`)
- Loud expiry: a hold that dies unanswered posts its own notification
- Secret lives in the Keychain (app-owned item), never in defaults

## Build

```bash
./build-app.sh
open "dist/Gatekeeper Bar.app"    # or cp -R into /Applications
```

Requires macOS 13+ and a gatekeeper ≥ 0.7 (`GET /approvals/pending`).

## Configure

Click the shield icon → Settings → enter the gatekeeper URL (default
`http://127.0.0.1:3847`) and your `GATEKEEPER_SECRET`.

Headless setup (e.g. provisioning scripts): write the secret to defaults once —
the app imports it into the Keychain on next launch and deletes it from defaults:

```bash
defaults write com.runestonelabs.gatekeeper-bar gatekeeperBaseURL "http://127.0.0.1:3847"
defaults write com.runestonelabs.gatekeeper-bar bootstrapSecret "<GATEKEEPER_SECRET>"
```

## Why the secret is required

`GET /approvals/pending` returns live signed approve/deny URLs. It is
deliberately privileged: an unauthenticated inbox would let a gated agent on
the same host approve its own holds. See `docs/APPROVALS.md`.

## Recommended server settings

```bash
# A 1h TTL guarantees missed holds for a human approver. Use 24h.
APPROVAL_EXPIRY_MS=86400000
```
