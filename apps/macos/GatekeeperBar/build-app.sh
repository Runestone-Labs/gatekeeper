#!/bin/bash
# Build Gatekeeper Bar.app from the Swift package.
#
# User notifications require a real .app bundle with a bundle identifier —
# a bare SPM executable can't post them. So: swift build, then assemble the
# bundle by hand and ad-hoc sign it.
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="Gatekeeper Bar"
DIST="dist"
BUNDLE="$DIST/$APP_NAME.app"

echo "==> swift build -c release"
swift build -c release

echo "==> assembling $BUNDLE"
rm -rf "$BUNDLE"
mkdir -p "$BUNDLE/Contents/MacOS" "$BUNDLE/Contents/Resources"
cp ".build/release/GatekeeperBar" "$BUNDLE/Contents/MacOS/GatekeeperBar"
cp Info.plist "$BUNDLE/Contents/Info.plist"
printf 'APPL????' > "$BUNDLE/Contents/PkgInfo"

echo "==> codesign (ad-hoc)"
codesign --force --deep --sign - "$BUNDLE"

echo "==> done: $BUNDLE"
echo "    launch:  open \"$BUNDLE\""
echo "    install: cp -R \"$BUNDLE\" /Applications/"
