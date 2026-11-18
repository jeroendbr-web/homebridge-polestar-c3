# homebridge-polestar-c3

[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=flat)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)
[![Tests](https://github.com/jeroendbr-web/homebridge-polestar-c3/actions/workflows/test.yml/badge.svg)](https://github.com/jeroendbr-web/homebridge-polestar-c3/actions/workflows/test.yml)
[![Release](https://img.shields.io/github/v/release/jeroendbr-web/homebridge-polestar-c3?label=release)](https://github.com/jeroendbr-web/homebridge-polestar-c3/releases)
[![Homebridge](https://img.shields.io/badge/homebridge-1.8%20%7C%202.x-491F59?logo=homebridge)](https://homebridge.io)
[![Node](https://img.shields.io/badge/node-22%20%7C%2024%20%7C%2026-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![License](https://img.shields.io/github/license/jeroendbr-web/homebridge-polestar-c3)](LICENSE)

Unofficial [Homebridge](https://homebridge.io) plugin for the Polestar 2, 3 and 4. Control and monitor your Polestar from the Apple Home app: lock, climate, charging, battery, doors and more.

The plugin talks to the same cloud backend as the official Polestar app (C3, gRPC), using the JavaScript client from the [Homey Polestar app](https://github.com/kaohlive/Polestar) by Vincent Boer.

> ⚠️ Not affiliated with or endorsed by Polestar. The API is reverse-engineered and may change without notice. Use at your own risk.

## Accessories

| Accessory | HomeKit | Default |
|---|---|---|
| Lock (with battery %, charging state, low battery) | Lock + Battery | on |
| Climate | Switch or Thermostat | on (switch) |
| Charger connected | Contact sensor | on |
| Openings: doors, windows (+ sunroof), tailgate | 3 contact sensors | on |
| Warnings: tyre pressure, service | Occupancy sensors | off |
| Charging (overrides an active charging schedule) | Switch | off |
| Find my car (flash lights or honk) | Switch that turns itself off | off |

`disableWrites: true` is the kill switch: everything becomes read-only.

Not every Polestar supports every feature. Anything the backend reports as unsupported is logged once and then skipped.

## Requirements

- Homebridge 1.8+ or 2.x
- Node.js 22.12+, 24 or 26
- A Polestar ID (email + password) with the car linked to it

Running the plugin as a **child bridge** is recommended, so hiccups in the Polestar cloud don't affect the rest of your Homebridge.

## Installation

**From GitHub** (in the Homebridge terminal, in the folder that holds your other plugins, without `-g`):

```bash
npm install github:jeroendbr-web/homebridge-polestar-c3
```

**Or from a release file:** download `homebridge-polestar-c3-<version>.tgz` from [Releases](https://github.com/jeroendbr-web/homebridge-polestar-c3/releases) and install it with `npm install <path>/homebridge-polestar-c3-<version>.tgz`.

Then restart Homebridge and fill in your details under **Plugins → Polestar → Settings**.

## Configuration

```json
{
  "platform": "PolestarC3",
  "email": "you@example.com",
  "password": "••••••••",
  "climateAccessory": "switch",
  "climateTemperature": 21,
  "enableOpenings": true,
  "enableWarnings": false
}
```

| Option | Description | Default |
|---|---|---|
| `email`, `password` | Polestar ID | — |
| `vin` | Only needed with multiple vehicles | first vehicle |
| `pollIntervalMinutes` | Refresh interval | 10 |
| `activePollIntervalMinutes` | Interval while charging or climate is on | 2 |
| `climateAccessory` | `switch` or `thermostat` | `switch` |
| `climateTemperature` | Target temperature (16–28 °C) | 21 |
| `lowBatteryThreshold` | Low battery threshold (%) | 20 |
| `enableLock`, `enableClimate`, `enableChargerSensor`, `enableOpenings` | Accessory on/off | `true` |
| `enableWarnings`, `enableChargeSwitch`, `enableHonkFlash` | Accessory on/off | `false` |
| `honkFlashMode` | `flash` or `honk_and_flash` | `flash` |
| `disableWrites` | Read-only mode | `false` |

The login session (refresh token) is stored in `<homebridge storage>/polestar-c3/`, so the plugin does not log in with your password on every restart. Delete that folder to force a fresh login.

## Development

```bash
npm install
npm test
```

The Polestar client in `lib/polestar-c3/` is a copy of `clone_modules/polestar-c3/` from [kaohlive/Polestar](https://github.com/kaohlive/Polestar) (v3.5.0), with two small local changes, each marked with a `homebridge-polestar-c3:` comment:

- `grpc.js` only asks for uncompressed replies, and a compressed frame is rejected as an error instead of throwing in an event handler.
- `client.js` accepts an optional `logger` so its messages go through the Homebridge log.

When updating the client from upstream, re-apply these changes.

## Credits

- [kaohlive/Polestar](https://github.com/kaohlive/Polestar) (Vincent Boer): the C3 client this plugin is built on.
- [tabrindle/homebridge-polestar](https://github.com/tabrindle/homebridge-polestar): an earlier Polestar plugin for Homebridge.

## License

GPL-3.0-only, see [LICENSE](LICENSE).
