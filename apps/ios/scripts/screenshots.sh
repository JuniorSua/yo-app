#!/bin/sh
# Captures every App Store screenshot scene in light and dark mode on a booted simulator.
#   apps/ios/scripts/screenshots.sh <path/to/Yo.app> <output-dir> [simulator name or id]
# The scenes are local demo content (-YoScreenshotScene), so nothing personal ends up in them.
set -eu

APP="$1"
OUT="$2"
DEVICE="${3:-iPhone 18 Pro Max}"
BUNDLE=dev.yo.phone

xcrun simctl boot "$DEVICE" 2>/dev/null || true
xcrun simctl bootstatus "$DEVICE" -b >/dev/null
xcrun simctl status_bar "$DEVICE" override --time 9:41 --dataNetwork wifi --wifiMode active --wifiBars 3 \
  --cellularMode active --cellularBars 4 --batteryState discharging --batteryLevel 100
xcrun simctl install "$DEVICE" "$APP"
mkdir -p "$OUT"

for appearance in light dark; do
  xcrun simctl ui "$DEVICE" appearance "$appearance"
  for scene in welcome chat approval drive settings; do
    xcrun simctl terminate "$DEVICE" "$BUNDLE" 2>/dev/null || true
    xcrun simctl launch "$DEVICE" "$BUNDLE" -YoScreenshotScene "$scene" >/dev/null
    sleep 4
    xcrun simctl io "$DEVICE" screenshot "$OUT/$scene-$appearance.png" >/dev/null 2>&1
    echo "$OUT/$scene-$appearance.png"
  done
done
xcrun simctl terminate "$DEVICE" "$BUNDLE" 2>/dev/null || true
xcrun simctl ui "$DEVICE" appearance light
xcrun simctl status_bar "$DEVICE" clear
