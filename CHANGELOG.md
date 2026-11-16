# Changelog

## 0.2.0 — 16 november 2026
- Polestar C3-client bijgewerkt naar Homey Polestar v3.5.0: login-sessie (refresh token) wordt bewaard in de Homebridge-opslag, dus geen wachtwoord-login meer bij elke herstart; netwerkfouten laten de sessie intact; geen dubbele token-refresh meer.
- Auth-meldingen in het log (sessie hergebruikt / verlopen / wachtwoord-login).
- Niet-ondersteunde diensten (gRPC UNIMPLEMENTED, verschilt per Polestar 2/3/4) worden één keer gemeld en daarna overgeslagen.
- Opstarten mislukt? Automatisch opnieuw proberen (5 → 60 min). Netjes afsluiten bij Homebridge-shutdown.
- Sneller verversen tijdens laden of klimaat (`activePollIntervalMinutes`, standaard 2 min).
- HomeKit toont "Geen reactie" als er nog nooit (of al lang geen) data is, i.p.v. verzonnen waarden.
- Nieuw: klimaat als thermostaat (doeltemperatuur + interieurtemperatuur), sensoren portieren/ramen/achterklep, waarschuwingen bandenspanning/onderhoud, knop "auto zoeken" (knipperen/toeteren).
- Slot zet de doelstatus terug als een commando mislukt.
- `ConfiguredName` op services, firmwareversie van de auto in de accessoire-info, accessoire-categorieën.
- Homebridge 2.x klaar: `engines` node `^22.12 || ^24 || ^26`, homebridge `^1.8 || ^2.0`. Node 18/20 niet meer ondersteund.
- Config-scherm met secties, voorwaardelijke velden en `required`-array.
- Smoke-test met echte HAP-NodeJS (`npm test`).

## 0.1.0 — 6 juli 2026
- Eerste versie: slot + batterij, klimaatschakelaar, lader-sensor, optionele laadschakelaar.
