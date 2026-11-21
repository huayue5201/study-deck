#!/usr/bin/env bash
# 打包 macOS .app：优先做 universal（arm64 + x86_64），再做 ad-hoc 签名。
# 不依赖 tauri-cli，Info.plist 与图标自己写。
set -euo pipefail
cd "$(dirname "$0")"

APP="../../target/StudyDeck.app"
ARM_BIN="../../target/release/desktop"
X86_BIN="../../target/x86_64-apple-darwin/release/desktop"

echo "==> 编译 arm64"
( cd ../.. && cargo build --release -p desktop )

UNIVERSAL=0
if rustup target list --installed 2>/dev/null | grep -q x86_64-apple-darwin; then
  echo "==> 编译 x86_64"
  ( cd ../.. && cargo build --release -p desktop --target x86_64-apple-darwin )
  UNIVERSAL=1
else
  echo "!! 未安装 x86_64 target，跳过（仅 arm64）。安装：rustup target add x86_64-apple-darwin"
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

if [ "$UNIVERSAL" = "1" ]; then
  lipo -create -output "$APP/Contents/MacOS/StudyDeck" "$ARM_BIN" "$X86_BIN"
else
  cp "$ARM_BIN" "$APP/Contents/MacOS/StudyDeck"
fi
chmod +x "$APP/Contents/MacOS/StudyDeck"
cp src-tauri/icons/icon.icns "$APP/Contents/Resources/icon.icns"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>StudyDeck</string>
    <key>CFBundleDisplayName</key><string>StudyDeck</string>
    <key>CFBundleIdentifier</key><string>dev.studydeck.app</string>
    <key>CFBundleVersion</key><string>0.1.0</string>
    <key>CFBundleShortVersionString</key><string>0.1.0</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleExecutable</key><string>StudyDeck</string>
    <key>CFBundleIconFile</key><string>icon.icns</string>
    <key>LSMinimumSystemVersion</key><string>11.0</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>NSAppTransportSecurity</key>
    <dict><key>NSAllowsLocalNetworking</key><true/></dict>
    <key>CFBundleURLTypes</key>
    <array>
        <dict>
            <key>CFBundleURLName</key><string>dev.studydeck.app</string>
            <key>CFBundleURLSchemes</key><array><string>studydeck</string></array>
        </dict>
    </array>
</dict>
</plist>
PLIST

codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || echo "（跳过签名）"
echo "built: $(cd "$APP" && pwd)"
file "$APP/Contents/MacOS/StudyDeck"
