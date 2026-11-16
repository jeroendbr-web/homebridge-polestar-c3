# homebridge-polestar-c3

Onofficiële Homebridge plugin voor Polestar 2/3/4. Praat met dezelfde cloud-backend als de officiële Polestar-app (C3), via de JavaScript-client uit de [Homey Polestar app](https://github.com/kaohlive/Polestar) van Vincent Boer (GPL-3.0).

Accessoires in HomeKit: Slot (met batterij), Klimaat-schakelaar, Lader-sensor, optionele Laad-schakelaar (schema-override). Config via de Homebridge UI; `disableWrites: true` maakt alles alleen-lezen.

Installatie in Docker-Homebridge: tarball bouwen met `npm pack`, dan in de container `npm install <pad>.tgz` in de map waar ook je andere plugins staan (zonder -g), en herstarten.

Zie CLAUDE.md voor projectstatus en vervolgstappen.
