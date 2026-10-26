#!/bin/bash
# Publishes the notarised build/Agent Huddle.dmg (from ./build.sh --release) as an automatic update.
#
#   ./publish.sh
#
# It keeps every release in macos/releases/, has Sparkle's generate_appcast sign them with your update key
# (from your Keychain) and write appcast.xml, then uploads the new .dmg and the appcast to the
# agenthuddle-updates bucket, served at https://updates.agenthuddle.net/. Copies of Agent Huddle check that
# appcast once a day and install the update after asking (or by themselves, if the person allowed it).
#
# Release notes (optional): put them in macos/releases/AgentHuddle-<version>-<build>.html before running.
# One-time setup: sign in to Cloudflare with  "build/Agent Huddle.app/Contents/Resources/node/bin/npx" wrangler login
set -euo pipefail
cd "$(dirname "$0")"
APP="build/Agent Huddle.app"
DMG="build/Agent Huddle.dmg"
[[ -f "$DMG" ]] || { echo "Run ./build.sh --release first."; exit 1; }
xcrun stapler validate "$DMG" >/dev/null 2>&1 || { echo "The .dmg isn't notarised. Run ./build.sh --release (not a plain build)."; exit 1; }

VERSION=$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$APP/Contents/Info.plist")
BUILD=$(/usr/libexec/PlistBuddy -c 'Print CFBundleVersion' "$APP/Contents/Info.plist")
SP=$(ls -d "$HOME/Library/Caches/AgentHuddleBuild"/Sparkle-* | sort -V | tail -1)
NPX="$APP/Contents/Resources/node/bin/npx"
export PATH="$(dirname "$NPX"):$PATH"
BUCKET=agenthuddle-updates

mkdir -p releases
NAME="AgentHuddle-$VERSION-$BUILD.dmg"
cp "$DMG" "releases/$NAME"
echo "→ Signing and writing the appcast for $VERSION ($BUILD)…"
"$SP/bin/generate_appcast" --download-url-prefix "https://updates.agenthuddle.net/" --link "https://agenthuddle.net" \
  -o releases/appcast.xml releases

echo "→ Uploading…"
put() { "$NPX" --yes wrangler r2 object put "$BUCKET/$1" --file "$2" --content-type "$3" ${4:+--cache-control "$4"} --remote; }
put "$NAME" "releases/$NAME" application/x-apple-diskimage "public, max-age=31536000, immutable"
put AgentHuddle.dmg "releases/$NAME" application/x-apple-diskimage "no-cache"   # the "download" link for your website
put appcast.xml releases/appcast.xml application/xml "no-cache"
echo "✓ Published $VERSION ($BUILD). Download: https://updates.agenthuddle.net/AgentHuddle.dmg"
