#!/usr/bin/env bash
# Builds Glorby's lamp firmware: stock WLED plus the network watchdog, for the Glorb's ESP32-S3.
# Output: firmware/build/glorby-wled.bin, an app image for the lamp's /update page (Wi-Fi OTA).
set -euo pipefail
WLED_TAG="${WLED_TAG:-v16.0.1}"
here="$(cd "$(dirname "$0")" && pwd)"
work="$here/build/WLED"
mkdir -p "$here/build"
if [ ! -d "$work/.git" ]; then
  git clone --depth 1 --branch "$WLED_TAG" https://github.com/wled/WLED.git "$work"
fi
rm -rf "$work/usermods/net_watchdog"
cp -r "$here/usermods/net_watchdog" "$work/usermods/"
cp "$here/platformio_override.ini" "$work/platformio_override.ini"
pio="$(command -v pio || true)"
if [ -z "$pio" ]; then
  [ -x "$here/build/venv/bin/pio" ] || { python3 -m venv "$here/build/venv" && "$here/build/venv/bin/pip" install -q platformio; }
  pio="$here/build/venv/bin/pio"
fi
(cd "$work" && "$pio" run -e glorb_s3)
cp "$work/.pio/build/glorb_s3/firmware.bin" "$here/build/glorby-wled.bin"
shasum -a 256 "$here/build/glorby-wled.bin" 2>/dev/null || sha256sum "$here/build/glorby-wled.bin"
ls -l "$here/build/glorby-wled.bin"
