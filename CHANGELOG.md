# Changelog

## 0.2.2 — 17 November 2026
- Fix: about once an hour a refresh failed with "Refresh failed: no status could be read". The Polestar backend closes the connection roughly every hour (HTTP/2 GOAWAY) and requests in flight were cancelled without a retry. Each status read now retries once on a fresh connection.
- "Refresh failed" now includes the underlying reason.
- Fix: a refresh error was not reported when one of the services is unsupported by the vehicle.

## 0.2.1 — 16 November 2026
- Everything in English: log messages, accessory names, settings screen and documentation.
- Existing accessories keep the names they already have in the Home app; only newly added accessories get English names.

## 0.2.0 — 16 November 2026
- Polestar C3 client updated to Homey Polestar v3.5.0: the login session (refresh token) is stored in Homebridge storage, so there is no password login on every restart; network errors keep the session; no more duplicate token refreshes.
- Auth events in the log (session restored / expired / password login).
- Unsupported services (gRPC UNIMPLEMENTED, differs between Polestar 2/3/4) are reported once and then skipped.
- Startup failed? Automatic retry (5 → 60 min). Clean shutdown when Homebridge stops.
- Faster refresh while charging or climate is on (`activePollIntervalMinutes`, default 2 min).
- HomeKit shows "No Response" when there has never been (or not for a long time) any data, instead of made-up values.
- New: climate as a thermostat (target + cabin temperature), door/window/tailgate sensors, tyre pressure/service warnings, "find my car" button (flash/honk).
- The lock reverts its target state when a command fails.
- `ConfiguredName` on services, vehicle firmware version in accessory info, accessory categories.
- Ready for Homebridge 2.x: `engines` node `^22.12 || ^24 || ^26`, homebridge `^1.8 || ^2.0`. Node 18/20 no longer supported.
- Settings screen with sections, conditional fields and a `required` array.
- Smoke test with real HAP-NodeJS (`npm test`).

## 0.1.0 — 6 July 2026
- First version: lock + battery, climate switch, charger sensor, optional charging switch.
