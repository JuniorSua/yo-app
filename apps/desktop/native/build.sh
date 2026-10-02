#!/usr/bin/env bash
# Builds the YoDeviceBridge helper for Apple silicon and stages it in native/bin/.
# The binary is intentionally unsigned; packaging signs it.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
package="$here/YoDeviceBridge"

swift build -c release --arch arm64 --package-path "$package"
bin_dir="$(swift build -c release --arch arm64 --package-path "$package" --show-bin-path)"

mkdir -p "$here/bin"
cp "$bin_dir/YoDeviceBridge" "$here/bin/YoDeviceBridge"
chmod 755 "$here/bin/YoDeviceBridge"
echo "Built $here/bin/YoDeviceBridge"
