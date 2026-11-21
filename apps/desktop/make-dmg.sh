#!/usr/bin/env bash
# 把 .app 装进 DMG：拖进 Applications 就算安装完成。
set -euo pipefail
cd "$(dirname "$0")"

VERSION="$(grep -m1 '"version"' src-tauri/tauri.conf.json | sed -E 's/.*"version": *"([^"]+)".*/\1/')"
APP="../../target/StudyDeck.app"
DMG="../../target/StudyDeck-${VERSION}.dmg"
STAGE="../../target/dmg-stage"

[ -d "$APP" ] || ./make-app.sh

rm -rf "$STAGE" "$DMG"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

hdiutil create -volname "StudyDeck" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"

echo "built: $(cd "$(dirname "$DMG")" && pwd)/$(basename "$DMG")"
shasum -a 256 "$DMG" | awk '{print "sha256:", $1}'
