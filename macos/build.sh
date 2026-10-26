#!/bin/bash
# Builds "Agent Huddle.app" and (optionally) installs it into /Applications.
#   ./build.sh            build into macos/build/
#   ./build.sh --install  build, copy to /Applications and open it
#   ./build.sh --release  build, sign with your Developer ID, notarise, and make a .dmg
#   ./publish.sh          after --release: publish that .dmg as an automatic update (Sparkle)
# Needs Xcode or the Command Line Tools (xcode-select --install) and an internet connection the
# first time (it downloads Node.js and cloudflared, and installs the server's two npm packages).
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"
APP="build/Agent Huddle.app"
RES="$APP/Contents/Resources"
CACHE="$HOME/Library/Caches/AgentHuddleBuild"
ARCH="$(uname -m)"                                   # arm64 or x86_64
NODE_ARCH=$([[ "$ARCH" == "arm64" ]] && echo arm64 || echo x64)
CF_ARCH=$([[ "$ARCH" == "arm64" ]] && echo arm64 || echo amd64)
mkdir -p "$CACHE"
rm -rf build && mkdir -p "$APP/Contents/MacOS" "$RES"

# Sparkle (auto-updates): the newest release, cached between builds.
SPARKLE_TAG=$(curl -fsSI https://github.com/sparkle-project/Sparkle/releases/latest 2>/dev/null | awk -F/ 'tolower($1) ~ /^location:/ {print $NF}' | tr -d '\r' || true)
SPARKLE_TAG="${SPARKLE_TAG:-$(ls -d "$CACHE"/Sparkle-* 2>/dev/null | sed 's/.*Sparkle-//' | sort -V | tail -1)}"
[[ -n "$SPARKLE_TAG" ]] || { echo "Couldn't find Sparkle's latest release — check your internet connection."; exit 1; }
SP="$CACHE/Sparkle-$SPARKLE_TAG"
if [[ ! -d "$SP/Sparkle.framework" ]]; then
  echo "→ Downloading Sparkle ${SPARKLE_TAG}…"
  curl -fL --progress-bar -o "$SP.tar.xz" "https://github.com/sparkle-project/Sparkle/releases/download/$SPARKLE_TAG/Sparkle-$SPARKLE_TAG.tar.xz"
  mkdir -p "$SP" && tar -xJf "$SP.tar.xz" -C "$SP"
fi

echo "→ Compiling…"
swiftc -O -target "$ARCH-apple-macos12.0" \
  -framework Cocoa -framework WebKit -framework UserNotifications \
  -F "$SP" -framework Sparkle -Xlinker -rpath -Xlinker @executable_path/../Frameworks \
  -o "$APP/Contents/MacOS/AgentHuddle" main.swift
mkdir -p "$APP/Contents/Frameworks" && ditto "$SP/Sparkle.framework" "$APP/Contents/Frameworks/Sparkle.framework"
# The login console's terminal helper (macOS's own `script` won't run without a terminal of its own).
mkdir -p "$RES/app/bin" && clang -O2 -Wall -mmacosx-version-min=12.0 -o "$RES/app/bin/ahpty" ahpty.c

echo "→ Making the icon…"
ICONSET=build/AppIcon.iconset; mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s AppIcon-1024.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  d=$((s*2)); sips -z $d $d AppIcon-1024.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$RES/AppIcon.icns"
# Bundle identifier: set BUNDLE_ID to your own reverse-domain name when you publish.
BUNDLE_ID="${BUNDLE_ID:-net.agenthuddle.mac}"
# Version: macos/VERSION for people, the commit count for Sparkle (it must go up with every release).
VERSION="$(tr -d '[:space:]' < VERSION)"
BUILD="$(cd "$ROOT" && git rev-list --count HEAD 2>/dev/null || date +%s)"
# Updates are signed with an EdDSA key kept in your login Keychain (made the first time). Only its public
# half goes in the app. Building on another Mac? Move the key first: generate_keys -x file / -f file.
SPARKLE_PUB="$("$SP/bin/generate_keys" -p 2>/dev/null || true)"
if [[ -z "$SPARKLE_PUB" ]]; then
  echo "→ Creating your update-signing key (saved in your Keychain as \"Private key for signing Sparkle updates\")…"
  "$SP/bin/generate_keys" >/dev/null
  SPARKLE_PUB="$("$SP/bin/generate_keys" -p)"
fi
sed -e "s/net.agenthuddle.mac/$BUNDLE_ID/" -e "s/__VERSION__/$VERSION/" -e "s/__BUILD__/$BUILD/" -e "s#__SPARKLE_PUBLIC_KEY__#$SPARKLE_PUB#" \
  Info.plist > "$APP/Contents/Info.plist"
echo "  version $VERSION ($BUILD)"

# The newest Node.js 22 release (the server needs Node 22 or later); cached between builds.
NODE_FILE=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | awk '{print $2}' | grep -E "^node-v[0-9.]+-darwin-$NODE_ARCH\.tar\.gz$" | head -1)
[[ -n "$NODE_FILE" ]] || { echo "Couldn't find the Node.js download — check your internet connection."; exit 1; }
echo "→ Adding ${NODE_FILE}…"
NODE_TGZ="$CACHE/$NODE_FILE"
[[ -f "$NODE_TGZ" ]] || curl -fL --progress-bar -o "$NODE_TGZ" "https://nodejs.org/dist/latest-v22.x/$NODE_FILE"
mkdir -p "$RES/node" && tar -xzf "$NODE_TGZ" -C "$RES/node" --strip-components 1
rm -rf "$RES/node/share"
export PATH="$PWD/$RES/node/bin:$PATH"

echo "→ Adding the Agent Huddle server…"
mkdir -p "$RES/app/container"
cp -R "$ROOT/src" "$ROOT/public" "$ROOT/local" "$RES/app/"
cp "$ROOT/wrangler.jsonc" "$ROOT/package.json" "$ROOT/package-lock.json" "$RES/app/"
cp "$ROOT"/container/*.mjs "$ROOT/container/Dockerfile" "$RES/app/container/"
(cd "$ROOT" && git rev-parse --short HEAD 2>/dev/null || date +%s) > "$RES/app/VERSION"
date +%s >> "$RES/app/VERSION"                       # every build counts as a new version
# The encrypted-database package ships ready-made binaries for macOS, so no compiling is needed.
(cd "$RES/app" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
rm -rf "$RES/node/include"
SQ="$RES/app/node_modules/better-sqlite3-multiple-ciphers"
find "$SQ/prebuilds" -type f ! -name "darwin-$NODE_ARCH.node" -delete
rm -rf "$SQ/deps" "$SQ/src" "$SQ/build"
"$RES/node/bin/node" -e "const D=require('$PWD/$SQ'); const d=new D(':memory:'); d.pragma(\"cipher='sqlcipher'\"); d.close()" \
  || { echo "The encrypted-database module doesn't load on this Mac."; exit 1; }
# The encrypted database and WebSockets are required on the Mac (they are optional for the cloud build).
[[ -d "$RES/app/node_modules/better-sqlite3-multiple-ciphers" && -d "$RES/app/node_modules/ws" ]] || { echo "Missing server packages (better-sqlite3-multiple-ciphers, ws)."; exit 1; }

echo "→ Adding cloudflared (for the phone relay)…"
CF_TGZ="$CACHE/cloudflared-darwin-$CF_ARCH.tgz"
[[ -f "$CF_TGZ" ]] || curl -fL --progress-bar -o "$CF_TGZ" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-$CF_ARCH.tgz"
mkdir -p "$RES/app/bin" && tar -xzf "$CF_TGZ" -C "$RES/app/bin" && chmod +x "$RES/app/bin/cloudflared"

# ---------- signing ----------
# With a "Developer ID Application" certificate in your Keychain the app is signed with it and the
# hardened runtime (needed for notarisation); otherwise it's signed ad-hoc, which only runs on this Mac.
# Pick a certificate with SIGN_ID="Developer ID Application: Your Name (TEAMID)" if you have several.
SIGN_ID="${SIGN_ID:-$(security find-identity -v -p codesigning 2>/dev/null | grep -o '"Developer ID Application: [^"]*"' | head -1 | tr -d '"')}"
if [[ -n "$SIGN_ID" ]]; then
  echo "→ Signing with ${SIGN_ID}…"
  SIGN=(codesign --force --options runtime --timestamp --sign "$SIGN_ID")
else
  echo "→ Signing (ad-hoc, for this Mac only — no Developer ID certificate found)…"
  SIGN=(codesign --force --sign -)
fi
# Every executable and native library inside the app is signed first, then the app itself.
while IFS= read -r -d '' f; do
  if file -b "$f" | grep -Eq "Mach-O.*(executable|bundle|shared library)"; then
    if [[ "$f" == "$RES/node/bin/node" ]]; then "${SIGN[@]}" --entitlements node.entitlements "$f" >/dev/null
    else "${SIGN[@]}" "$f" >/dev/null; fi
  fi
done < <(find "$RES" -type f \( -perm -u+x -o -name "*.node" -o -name "*.dylib" \) -print0)
# Sparkle's helpers, innermost first (as Sparkle's documentation describes for Developer ID apps).
FW="$APP/Contents/Frameworks/Sparkle.framework"
for x in "$FW/Versions/B/XPCServices/Installer.xpc" "$FW/Versions/B/XPCServices/Downloader.xpc" "$FW/Versions/B/Autoupdate" "$FW/Versions/B/Updater.app" "$FW"; do
  [[ -e "$x" ]] || continue
  if [[ "$x" == *Downloader.xpc ]]; then "${SIGN[@]}" --preserve-metadata=entitlements "$x" >/dev/null; else "${SIGN[@]}" "$x" >/dev/null; fi
done
"${SIGN[@]}" "$APP"
codesign --verify --deep --strict "$APP" && echo "  signature OK"

# ---------- notarisation (./build.sh --release) ----------
# One-time setup:  xcrun notarytool store-credentials AgentHuddle --apple-id you@example.com --team-id TEAMID
# (use an app-specific password from appleid.apple.com). Then --release notarises the app, staples the
# ticket, and makes build/Agent Huddle.dmg ready to put on your website.
if [[ "${1:-}" == "--release" ]]; then
  [[ -n "$SIGN_ID" ]] || { echo "A Developer ID Application certificate is needed for a release."; exit 1; }
  PROFILE="${NOTARY_PROFILE:-AgentHuddle}"
  echo "→ Notarising (this can take a few minutes)…"
  ditto -c -k --keepParent "$APP" "build/AgentHuddle.zip"
  xcrun notarytool submit "build/AgentHuddle.zip" --keychain-profile "$PROFILE" --wait
  xcrun stapler staple "$APP"
  echo "→ Making the disk image…"
  hdiutil create -volname "Agent Huddle" -srcfolder "$APP" -ov -format UDZO "build/Agent Huddle.dmg" >/dev/null
  codesign --force --timestamp --sign "$SIGN_ID" "build/Agent Huddle.dmg"
  xcrun notarytool submit "build/Agent Huddle.dmg" --keychain-profile "$PROFILE" --wait
  xcrun stapler staple "build/Agent Huddle.dmg"
  spctl -a -t open --context context:primary-signature -v "build/Agent Huddle.dmg" || true
  echo "✓ Release ready: macos/build/Agent Huddle.dmg — run ./publish.sh to send it out as an update"
  open -R "build/Agent Huddle.dmg"
  exit 0
fi

if [[ "${1:-}" == "--install" ]]; then
  osascript -e 'quit app "Agent Huddle"' 2>/dev/null || true
  sleep 1
  rm -rf "/Applications/Agent Huddle.app"
  cp -R "$APP" /Applications/
  echo "✓ Installed to /Applications/Agent Huddle.app"
  open "/Applications/Agent Huddle.app"
else
  echo "✓ Built: macos/$APP   (run ./build.sh --install to put it in Applications)"
  open -R "$APP"
fi
