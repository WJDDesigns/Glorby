# Lamp firmware

GLORB's own firmware (0.14.4-GLORB 1.2 and 1.3) has a Wi-Fi fault: after minutes to hours
the lamp stops answering on the network while its LEDs keep running and the access point
still lists it as connected. Only a restart brings it back, and the firmware's own recovery
sometimes takes 19 minutes and sometimes never comes.

This folder builds stock [WLED](https://github.com/wled/WLED) (v16.0.1, Arduino core 2.0.18 /
ESP-IDF 4.4.8, newer than GLORB's 4.4.3) for the lamp, with two additions:

- `usermods/net_watchdog`: pings the gateway every 5 s. After 3 misses in a row while
  Wi-Fi still says "connected", it forces a Wi-Fi reconnect. If the gateway is still silent
  60 s later, it restarts the lamp. It only arms once the gateway has answered, so
  networks that block ping are left alone. Settings live under `NetWatchdog` in `cfg.json`,
  and counters show in `/json/info` under `netwd`.
- `usermods/glorby_lease`: when a Glorby page has claimed the lamp (main segment named
  `Glorby …`) and no JSON has arrived for 60 s (longer than a Wi-Fi dropout), it ends the claim: live override off,
  segments unfrozen, name cleared, and the boot preset applied (or Colorwaves if none).
  That way a page that disappears without handing back, for example because the Mac slept,
  can't leave the lamp dark. Settings live under `GlorbyLease`, and `/json/info` shows `lease`.

The build uses the lamp's existing partition table (`WLED_ESP32_8MB.csv`, identical to
GLORB's), so it installs over Wi-Fi from the lamp's `/update` page and keeps `cfg.json`,
`presets.json` and `ledmap.json`. Sound (audioreactive) is built in; GLORB's own add-on,
its Bluetooth app control and HomeKit are not, since their source isn't public.

## Build

    ./firmware/build.sh

Needs git and Python. The image lands in `firmware/build/glorby-wled.bin`.

## After installing

- WLED 16 only treats the lamp as its 20x6 grid when `ledmap.json` says so. Add
  `"width":20,"height":6` next to `"map"` in `/ledmap.json` (edit it at `/edit`), then restart.
- GLORB's own effects (ids 187 and up) don't exist in WLED. Presets that used one play a
  different effect, so point them at a WLED effect, for example Colorwaves (67).

## Install and go back

Upload `glorby-wled.bin` at `http://<lamp>/update`. To return to GLORB's firmware, upload
GLORB's `firmware_gma_83.bin` the same way (from their GLORB-WebInstaller repository), or
write back a full flash backup over USB with esptool.
