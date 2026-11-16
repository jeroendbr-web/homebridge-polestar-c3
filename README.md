# homebridge-polestar-c3

[![Release](https://img.shields.io/github/v/release/jeroendbr-web/homebridge-polestar-c3?label=release)](https://github.com/jeroendbr-web/homebridge-polestar-c3/releases)
[![Homebridge](https://img.shields.io/badge/homebridge-1.8%20%7C%202.x-491F59?logo=homebridge)](https://homebridge.io)
[![Node](https://img.shields.io/badge/node-22%20%7C%2024%20%7C%2026-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![License](https://img.shields.io/github/license/jeroendbr-web/homebridge-polestar-c3)](LICENSE)

Onofficiële [Homebridge](https://homebridge.io) plugin voor Polestar 2, 3 en 4. Bedien en volg je Polestar in de Apple Woning-app: slot, klimaat, laden, batterij, portieren en meer.

De plugin praat met dezelfde cloud-backend als de officiële Polestar-app (C3, gRPC), via de JavaScript-client uit de [Homey Polestar app](https://github.com/kaohlive/Polestar) van Vincent Boer.

> *English:* Unofficial Homebridge plugin for Polestar 2/3/4 using the same C3 cloud backend as the official Polestar app. Exposes lock, battery/charging, climate, charger, doors/windows/tailgate and warnings to HomeKit. Log messages and settings are in Dutch.

> ⚠️ Niet gelieerd aan of goedgekeurd door Polestar. De API is reverse-engineered en kan zonder waarschuwing veranderen. Gebruik op eigen risico.

## Accessoires

| Accessoire | HomeKit | Standaard |
|---|---|---|
| Slot (met batterij %, laadstatus, batterij laag) | Slot + Batterij | aan |
| Klimaat | Schakelaar of Thermostaat | aan (schakelaar) |
| Lader aangesloten | Contactsensor | aan |
| Openingen: portieren, ramen (+ schuifdak), achterklep | 3 contactsensoren | aan |
| Waarschuwingen: bandenspanning, onderhoud | Bezettingssensoren | uit |
| Laden (override van een actief laadschema) | Schakelaar | uit |
| Auto zoeken (knipperen of toeteren) | Schakelaar die terugspringt | uit |

`disableWrites: true` is de noodrem: alles wordt alleen-lezen.

Niet elke Polestar ondersteunt elke functie. Wat de backend als niet-ondersteund meldt, wordt één keer gelogd en daarna overgeslagen.

## Vereisten

- Homebridge 1.8+ of 2.x
- Node.js 22.12+, 24 of 26
- Een Polestar ID (e-mail + wachtwoord) met de auto gekoppeld

Draai de plugin bij voorkeur als **child bridge**, zodat haperingen van de Polestar-cloud de rest van je Homebridge niet raken.

## Installatie

**Vanaf GitHub** (in de Homebridge-terminal, in de map met je andere plugins, zonder `-g`):

```bash
npm install github:jeroendbr-web/homebridge-polestar-c3
```

**Of met een release-bestand:** download `homebridge-polestar-c3-<versie>.tgz` bij [Releases](https://github.com/jeroendbr-web/homebridge-polestar-c3/releases) en installeer met `npm install <pad>/homebridge-polestar-c3-<versie>.tgz`.

Herstart daarna Homebridge en vul je gegevens in via **Plugins → Polestar → Instellingen**.

## Configuratie

```json
{
  "platform": "PolestarC3",
  "email": "jij@voorbeeld.nl",
  "password": "••••••••",
  "climateAccessory": "switch",
  "climateTemperature": 21,
  "enableOpenings": true,
  "enableWarnings": false
}
```

| Optie | Uitleg | Standaard |
|---|---|---|
| `email`, `password` | Polestar ID | — |
| `vin` | Alleen nodig bij meerdere auto's | eerste auto |
| `pollIntervalMinutes` | Ververs-interval | 10 |
| `activePollIntervalMinutes` | Interval tijdens laden/klimaat | 2 |
| `climateAccessory` | `switch` of `thermostat` | `switch` |
| `climateTemperature` | Doeltemperatuur (16–28 °C) | 21 |
| `lowBatteryThreshold` | Drempel "batterij laag" (%) | 20 |
| `enableLock`, `enableClimate`, `enableChargerSensor`, `enableOpenings` | Accessoire aan/uit | `true` |
| `enableWarnings`, `enableChargeSwitch`, `enableHonkFlash` | Accessoire aan/uit | `false` |
| `honkFlashMode` | `flash` of `honk_and_flash` | `flash` |
| `disableWrites` | Alleen-lezen | `false` |

De login-sessie (refresh token) wordt bewaard in `<homebridge-opslag>/polestar-c3/`, zodat niet bij elke herstart opnieuw met het wachtwoord wordt ingelogd. Verwijder die map om een nieuwe login af te dwingen.

## Ontwikkelen

```bash
npm install
npm test
```

De Polestar-client in `lib/polestar-c3/` is een ongewijzigde kopie van `clone_modules/polestar-c3/` uit [kaohlive/Polestar](https://github.com/kaohlive/Polestar). Bijwerken = die bestanden overnemen.

## Dank

- [kaohlive/Polestar](https://github.com/kaohlive/Polestar) (Vincent Boer): de C3-client waar deze plugin op draait.
- [tabrindle/homebridge-polestar](https://github.com/tabrindle/homebridge-polestar): eerdere Polestar-plugin voor Homebridge.

## Licentie

GPL-3.0, zie [LICENSE](LICENSE).
