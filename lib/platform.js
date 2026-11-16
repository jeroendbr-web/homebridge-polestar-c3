'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PolestarC3 } = require('./polestar-c3/client');
const { normalizeManualPreconditioning } = require('./polestar-c3/preconditioning');

const PLUGIN_NAME = 'homebridge-polestar-c3';
const PLATFORM_NAME = 'PolestarC3';

// Enum labels from lib/polestar-c3/messages.js
const CHARGING_LABELS = new Set(['CHARGING', 'SMART_CHARGING']);
const CHARGER_CONNECTED = 'CONNECTED';
const LOCKED = 'LOCKED';
const CLIMATE_ON_LABELS = new Set(['ACTIVE', 'START_ATTEMPT']);
const OPEN_LABELS = new Set(['OPEN', 'AJAR']);
const TYRE_WARNING_LABELS = new Set(['VERY_LOW_PRESSURE', 'LOW_PRESSURE', 'HIGH_PRESSURE']);

const DOORS = ['door_front_left', 'door_front_right', 'door_rear_left', 'door_rear_right'];
const WINDOWS = ['window_front_left', 'window_front_right', 'window_rear_left', 'window_rear_right'];

// Readers polled each cycle. Each one can be switched off for the session when
// the backend answers UNIMPLEMENTED (Polestar 2/3/4 differ per service).
const READERS = ['battery', 'exterior', 'climate', 'health'];

const AUTH_EVENTS = {
    session_restored: 'Opgeslagen sessie hergebruikt (geen wachtwoord-login nodig).',
    refresh_failed: 'Sessie verlopen of ingetrokken, opnieuw inloggen met wachtwoord.',
    password_login: 'Ingelogd met wachtwoord.',
    password_login_failed: 'Wachtwoord-login mislukt.',
    password_unavailable: 'Geen geldige sessie en geen wachtwoord beschikbaar.',
};

function isUnimplemented(err) {
    return !!err && /status=12\b|UNIMPLEMENTED/i.test(err.message || '');
}

/** gRPC-fout omzetten naar een korte Nederlandse melding. */
function friendlyError(err) {
    const msg = (err && err.message) || String(err);
    const m = /status=(\d+)[^m]*message="([^"]*)"/.exec(msg);
    if (!m) return msg;
    const code = Number(m[1]);
    const detail = m[2];
    switch (code) {
        case 12: return `niet ondersteund door deze auto (${detail})`;
        case 7: return `geen toegang (${detail || 'VIN niet gekoppeld aan dit account'})`;
        case 16: return 'authenticatie verlopen';
        case 14: return 'dienst tijdelijk niet bereikbaar';
        case 4: return 'time-out';
        default: return `${detail || 'fout'} (code ${code})`;
    }
}

class PolestarPlatform {
    constructor(log, config, api) {
        this.log = log;
        this.config = config || {};
        this.api = api;
        this.hap = api.hap;
        this.accessories = new Map(); // uuid -> PlatformAccessory (from cache)

        this.client = null;
        this.vehicle = null;
        this.pollTimer = null;
        this.retryTimer = null;
        this.retryDelayMin = 5;
        this.shuttingDown = false;
        this.unsupported = new Set(); // reader/command keys that returned UNIMPLEMENTED

        this.state = {
            lastOk: 0,
            batteryLevel: null,
            rangeKm: null,
            charging: false,
            chargerConnected: false,
            preconditioning: null,
            locked: null,
            tailgateOpen: false,
            doorsOpen: false,
            windowsOpen: false,
            climateOn: false,
            cabinTemp: null,
            climateTarget: null,
            tyreWarning: false,
            serviceWarning: false,
        };

        this.api.on('shutdown', () => this.shutdown());

        if (!this.config.email || !this.config.password) {
            this.log.error('Geen e-mail/wachtwoord geconfigureerd — plugin start niet. Vul ze in via de Homebridge UI.');
            return;
        }

        this.api.on('didFinishLaunching', () => this.startWithRetry());
    }

    configureAccessory(accessory) {
        this.accessories.set(accessory.UUID, accessory);
    }

    // ---------------------------------------------------------------
    // Startup, retry, shutdown
    // ---------------------------------------------------------------

    async startWithRetry() {
        try {
            await this.start();
            this.retryDelayMin = 5;
        } catch (err) {
            if (this.shuttingDown) return;
            this.log.error(`Opstarten mislukt: ${friendlyError(err)}. Nieuwe poging over ${this.retryDelayMin} min.`);
            this.retryTimer = setTimeout(() => this.startWithRetry(), this.retryDelayMin * 60 * 1000);
            this.retryTimer.unref && this.retryTimer.unref();
            this.retryDelayMin = Math.min(60, this.retryDelayMin * 2);
        }
    }

    async start() {
        if (this.client) { try { this.client.close(); } catch (_) { /* ignore */ } }

        this.log.info('Inloggen bij Polestar ID...');
        this.client = new PolestarC3(this.config.email, this.config.password, {
            tokens: this.loadSession(),
            onTokens: (tokens) => this.saveSession(tokens),
            onEvent: (type, detail) => this.logAuthEvent(type, detail),
        });
        await this.client.login();

        const vehicles = await this.client.listVehicles();
        const wantedVin = (this.config.vin || '').trim().toUpperCase();
        if ((!vehicles || vehicles.length === 0) && !wantedVin) {
            throw new Error('Geen voertuigen gevonden op dit Polestar-account. Vul eventueel het VIN handmatig in.');
        }
        this.vehicle = wantedVin
            ? (vehicles || []).find((v) => (v.vin || '').toUpperCase() === wantedVin) || { vin: wantedVin }
            : vehicles[0];
        if (vehicles && vehicles.length > 1 && !wantedVin) {
            this.log.warn(`Meerdere auto's gevonden (${vehicles.map((v) => v.vin).join(', ')}); eerste gekozen. Zet 'vin' in de config om te kiezen.`);
        }

        await this.client.setVehicle(this.vehicle.vin);
        const model = (this.vehicle.content && this.vehicle.content.model && this.vehicle.content.model.name) || 'Polestar';
        this.model = model;
        this.log.info(`Verbonden met ${model} (${this.vehicle.vin}).`);

        this.firmware = await this.readFirmware();
        this.setupAccessories();

        await this.refresh();
        this.scheduleNextPoll();
    }

    shutdown() {
        this.shuttingDown = true;
        clearTimeout(this.pollTimer);
        clearTimeout(this.retryTimer);
        if (this.client) { try { this.client.close(); } catch (_) { /* ignore */ } }
    }

    /** Sneller pollen terwijl er iets gebeurt (laden, klimaat aan). */
    scheduleNextPoll() {
        if (this.shuttingDown) return;
        clearTimeout(this.pollTimer);
        const normal = Math.max(2, Number(this.config.pollIntervalMinutes) || 10);
        const active = Math.max(1, Number(this.config.activePollIntervalMinutes) || 2);
        const busy = this.state.charging || this.state.climateOn;
        const minutes = busy ? Math.min(active, normal) : normal;
        this.pollTimer = setTimeout(async () => {
            try {
                await this.refresh();
            } catch (err) {
                this.log.warn(`Verversen mislukt: ${friendlyError(err)}`);
            }
            this.scheduleNextPoll();
        }, minutes * 60 * 1000);
        this.pollTimer.unref && this.pollTimer.unref();
    }

    // ---------------------------------------------------------------
    // Session persistence (refresh token) — avoids a password login on
    // every Homebridge restart.
    // ---------------------------------------------------------------

    sessionFile() {
        const id = crypto.createHash('sha256').update(String(this.config.email).toLowerCase()).digest('hex').slice(0, 16);
        return path.join(this.api.user.storagePath(), 'polestar-c3', `session-${id}.json`);
    }

    loadSession() {
        try {
            return JSON.parse(fs.readFileSync(this.sessionFile(), 'utf8'));
        } catch (_) {
            return null;
        }
    }

    saveSession(tokens) {
        try {
            const file = this.sessionFile();
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const { refresh_token, refresh_expires_in, obtained_at } = tokens;
            fs.writeFileSync(file, JSON.stringify({ refresh_token, refresh_expires_in, obtained_at }), { mode: 0o600 });
        } catch (err) {
            this.log.debug(`Sessie opslaan mislukt: ${err.message}`);
        }
    }

    logAuthEvent(type, detail) {
        const text = AUTH_EVENTS[type] || type;
        const extra = detail && (detail.error || detail.reason) ? ` (${detail.error || detail.reason})` : '';
        if (type === 'password_login_failed' || type === 'password_unavailable') this.log.error(text + extra);
        else if (type === 'refresh_failed') this.log.warn(text + extra);
        else this.log.info(text);
    }

    // ---------------------------------------------------------------
    // Accessory setup
    // ---------------------------------------------------------------

    setupAccessories() {
        const { Service, Characteristic } = this.hap;
        const c = this.config;
        const name = (suffix) => `${this.model} ${suffix}`;
        const wanted = [];

        // 1. Slot + batterij
        if (c.enableLock !== false) {
            wanted.push(this.ensureAccessory('lock', name('Slot'), this.hap.Categories.DOOR_LOCK, (acc) => {
                const lock = this.service(acc, Service.LockMechanism, name('Slot'));
                lock.getCharacteristic(Characteristic.LockCurrentState)
                    .onGet(() => this.read(() => this.lockCurrentState()));
                lock.getCharacteristic(Characteristic.LockTargetState)
                    .onGet(() => this.read(() => this.lockTargetState()))
                    .onSet(async (value) => {
                        const secure = value === Characteristic.LockTargetState.SECURED;
                        try {
                            await this.command(secure ? 'vergrendelen' : 'ontgrendelen', 'lock',
                                () => (secure ? this.client.lock() : this.client.unlock()));
                        } catch (err) {
                            // Target terugzetten zodat de Woning-app niet blijft "draaien"
                            setImmediate(() => lock.updateCharacteristic(Characteristic.LockTargetState, this.lockTargetState()));
                            throw err;
                        }
                        this.state.locked = secure;
                        lock.updateCharacteristic(Characteristic.LockCurrentState, this.lockCurrentState());
                    });
                this.addBattery(acc);
            }));
        }

        // 2. Klimaat: schakelaar of thermostaat
        if (c.enableClimate !== false) {
            const asThermostat = c.climateAccessory === 'thermostat';
            wanted.push(this.ensureAccessory(asThermostat ? 'climate-thermostat' : 'climate', name('Klimaat'),
                asThermostat ? this.hap.Categories.THERMOSTAT : this.hap.Categories.SWITCH,
                (acc) => (asThermostat ? this.setupThermostat(acc, name('Klimaat')) : this.setupClimateSwitch(acc, name('Klimaat')))));
        }

        // 3. Lader aangesloten
        if (c.enableChargerSensor !== false) {
            wanted.push(this.ensureAccessory('charger', name('Lader'), this.hap.Categories.SENSOR, (acc) => {
                const sensor = this.service(acc, Service.ContactSensor, name('Lader'));
                sensor.getCharacteristic(Characteristic.ContactSensorState)
                    .onGet(() => this.read(() => this.contact(this.state.chargerConnected)));
                if (c.enableLock === false) this.addBattery(acc);
            }));
        }

        // 4. Laad-override (alleen een actief laadschema)
        if (c.enableChargeSwitch === true) {
            wanted.push(this.ensureAccessory('charge', name('Laden'), this.hap.Categories.SWITCH, (acc) => {
                const sw = this.service(acc, Service.Switch, name('Laden'));
                sw.getCharacteristic(Characteristic.On)
                    .onGet(() => this.read(() => this.state.charging))
                    .onSet(async (on) => {
                        await this.command(on ? 'laden starten' : 'laden stoppen', 'charge',
                            () => (on ? this.client.chargeStart() : this.client.chargeStop()));
                        this.state.charging = !!on;
                    });
            }));
        }

        // 5. Openingen: portieren, ramen, achterklep
        if (c.enableOpenings !== false) {
            wanted.push(this.ensureAccessory('openings', name('Openingen'), this.hap.Categories.SENSOR, (acc) => {
                const parts = [
                    ['doors', 'Portieren', () => this.state.doorsOpen],
                    ['windows', 'Ramen', () => this.state.windowsOpen],
                    ['tailgate', 'Achterklep', () => this.state.tailgateOpen],
                ];
                for (const [subtype, label, get] of parts) {
                    const s = this.service(acc, Service.ContactSensor, name(label), subtype);
                    // HomeKit: CONTACT_DETECTED = dicht
                    s.getCharacteristic(Characteristic.ContactSensorState)
                        .onGet(() => this.read(() => this.contact(!get())));
                }
            }));
        }

        // 6. Waarschuwingen: bandenspanning / onderhoud
        if (c.enableWarnings === true) {
            wanted.push(this.ensureAccessory('warnings', name('Waarschuwingen'), this.hap.Categories.SENSOR, (acc) => {
                const parts = [
                    ['tyres', 'Bandenspanning', () => this.state.tyreWarning],
                    ['service', 'Onderhoud', () => this.state.serviceWarning],
                ];
                for (const [subtype, label, get] of parts) {
                    const s = this.service(acc, Service.OccupancySensor, name(label), subtype);
                    s.getCharacteristic(Characteristic.OccupancyDetected)
                        .onGet(() => this.read(() => (get()
                            ? Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
                            : Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED)));
                }
            }));
        }

        // 7. Knipperen/toeteren (stateless knop)
        if (c.enableHonkFlash === true) {
            wanted.push(this.ensureAccessory('honkflash', name('Zoeken'), this.hap.Categories.SWITCH, (acc) => {
                const sw = this.service(acc, Service.Switch, name('Zoeken'));
                sw.getCharacteristic(Characteristic.On)
                    .onGet(() => false)
                    .onSet(async (on) => {
                        if (!on) return;
                        const flashOnly = c.honkFlashMode !== 'honk_and_flash';
                        try {
                            await this.command(flashOnly ? 'knipperen' : 'toeteren en knipperen', 'honkflash',
                                () => this.client.honkFlash({ action: flashOnly ? 2 : 0 }), { refresh: false });
                        } finally {
                            setTimeout(() => sw.updateCharacteristic(Characteristic.On, false), 1000);
                        }
                    });
            }));
        }

        // Accessoires opruimen die niet meer gewenst zijn
        const keep = new Set(wanted);
        for (const [uuid, acc] of this.accessories) {
            if (!keep.has(uuid)) {
                this.log.info(`Accessoire '${acc.displayName}' verwijderd.`);
                this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
                this.accessories.delete(uuid);
            }
        }
    }

    setupClimateSwitch(acc, label) {
        const { Service, Characteristic } = this.hap;
        const sw = this.service(acc, Service.Switch, label);
        sw.getCharacteristic(Characteristic.On)
            .onGet(() => this.read(() => this.state.climateOn))
            .onSet(async (on) => {
                await this.setClimate(!!on);
                sw.updateCharacteristic(Characteristic.On, this.state.climateOn);
            });
    }

    setupThermostat(acc, label) {
        const { Service, Characteristic } = this.hap;
        const t = this.service(acc, Service.Thermostat, label);
        const H = Characteristic.CurrentHeatingCoolingState;
        const T = Characteristic.TargetHeatingCoolingState;

        t.getCharacteristic(Characteristic.TemperatureDisplayUnits)
            .onGet(() => Characteristic.TemperatureDisplayUnits.CELSIUS);
        t.getCharacteristic(H)
            .onGet(() => this.read(() => (this.state.climateOn ? H.HEAT : H.OFF)));
        t.getCharacteristic(T)
            .setProps({ validValues: [T.OFF, T.AUTO] })
            .onGet(() => this.read(() => (this.state.climateOn ? T.AUTO : T.OFF)))
            .onSet(async (value) => {
                await this.setClimate(value !== T.OFF);
                t.updateCharacteristic(H, this.state.climateOn ? H.HEAT : H.OFF);
            });
        const target = t.getCharacteristic(Characteristic.TargetTemperature);
        target.value = this.targetTemperature(); // HAP-standaard (10) valt buiten 16–28
        target.setProps({ minValue: 16, maxValue: 28, minStep: 0.5 })
            .onGet(() => this.targetTemperature())
            .onSet((value) => {
                this.state.climateTarget = Number(value);
                this.log.info(`Klimaat doeltemperatuur: ${value} °C (geldt bij volgende start).`);
            });
        t.getCharacteristic(Characteristic.CurrentTemperature)
            .setProps({ minValue: -40, maxValue: 80 })
            .onGet(() => this.read(() => (this.state.cabinTemp == null ? this.targetTemperature() : this.state.cabinTemp)));
    }

    addBattery(acc) {
        const { Service, Characteristic } = this.hap;
        const battery = acc.getService(Service.Battery) || acc.addService(Service.Battery);
        battery.getCharacteristic(Characteristic.BatteryLevel)
            .onGet(() => this.read(() => this.state.batteryLevel ?? 0));
        battery.getCharacteristic(Characteristic.ChargingState)
            .onGet(() => this.read(() => this.chargingState()));
        battery.getCharacteristic(Characteristic.StatusLowBattery)
            .onGet(() => this.read(() => this.lowBattery()));
    }

    /** Service ophalen of aanmaken, met ConfiguredName zodat de naam in de Woning-app klopt. */
    service(acc, type, displayName, subtype) {
        const { Characteristic } = this.hap;
        let s = subtype ? acc.getServiceById(type, subtype) : acc.getService(type);
        if (!s) s = acc.addService(type, displayName, subtype);
        if (!s.testCharacteristic(Characteristic.ConfiguredName)) s.addOptionalCharacteristic(Characteristic.ConfiguredName);
        if (!s.getCharacteristic(Characteristic.ConfiguredName).value) s.setCharacteristic(Characteristic.ConfiguredName, displayName);
        return s;
    }

    ensureAccessory(kind, displayName, category, configure) {
        const { Service, Characteristic } = this.hap;
        const uuid = this.hap.uuid.generate(`${PLUGIN_NAME}:${this.vehicle.vin}:${kind}`);
        let acc = this.accessories.get(uuid);
        const isNew = !acc;
        if (isNew) acc = new this.api.platformAccessory(displayName, uuid, category);
        acc.context.kind = kind;
        acc.context.vin = this.vehicle.vin;

        acc.getService(Service.AccessoryInformation)
            .setCharacteristic(Characteristic.Manufacturer, 'Polestar (onofficieel)')
            .setCharacteristic(Characteristic.Model, this.model)
            .setCharacteristic(Characteristic.SerialNumber, `${this.vehicle.vin}-${kind}`)
            .setCharacteristic(Characteristic.FirmwareRevision, this.firmware || require('../package.json').version);

        configure(acc);
        if (isNew) {
            this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
            this.accessories.set(uuid, acc);
            this.log.info(`Accessoire '${displayName}' toegevoegd.`);
        } else {
            this.api.updatePlatformAccessories([acc]);
        }
        return uuid;
    }

    async readFirmware() {
        try {
            const info = await this.client.getOtaSoftwareInfo();
            const v = info && info.current && (info.current.version || info.current.name);
            if (info && info.update_available) this.log.info('Er staat een software-update (OTA) klaar voor de auto.');
            // HomeKit accepteert alleen x.y.z
            const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(v || '');
            return m ? `${m[1]}.${m[2]}.${m[3] || 0}` : null;
        } catch (_) {
            return null;
        }
    }

    // ---------------------------------------------------------------
    // Polling
    // ---------------------------------------------------------------

    async readSafe(key, fn) {
        if (this.unsupported.has(key)) return null;
        try {
            return await fn();
        } catch (err) {
            if (isUnimplemented(err)) {
                this.unsupported.add(key);
                this.log.info(`Uitlezen '${key}' wordt niet ondersteund door deze auto; overgeslagen.`);
                return null;
            }
            this.log.debug(`Uitlezen '${key}' mislukt: ${friendlyError(err)}`);
            return undefined; // fout, niet "niet ondersteund"
        }
    }

    async refresh() {
        const s = this.state;
        const needHealth = this.config.enableWarnings === true;
        const [battery, exterior, climate, health] = await Promise.all([
            this.readSafe('battery', () => this.client.getLatestBattery()),
            this.readSafe('exterior', () => this.client.getLatestExterior()),
            this.readSafe('climate', () => this.client.getLatestClimate()),
            needHealth ? this.readSafe('health', () => this.client.getLatestHealth()) : null,
        ]);

        if (battery && battery.battery) {
            const b = battery.battery;
            s.batteryLevel = Math.round(Math.max(0, Math.min(100, Number(b.charge_level) || 0)));
            s.rangeKm = b.range_km != null ? Math.round(Number(b.range_km)) : null;
            s.charging = CHARGING_LABELS.has(b.charging_status_label);
            s.chargerConnected = b.charger_connection_status_label === CHARGER_CONNECTED;
            const pre = normalizeManualPreconditioning(b.manual_preconditioning);
            s.preconditioning = pre.reported ? pre.key : null;
        }

        if (exterior && exterior.exterior) {
            const e = exterior.exterior;
            if (e.central_lock_label === LOCKED || e.central_lock_label === 'UNLOCKED') s.locked = e.central_lock_label === LOCKED;
            s.doorsOpen = DOORS.some((k) => OPEN_LABELS.has(e[`${k}_label`]));
            s.windowsOpen = WINDOWS.some((k) => OPEN_LABELS.has(e[`${k}_label`])) || OPEN_LABELS.has(e.sunroof_label);
            s.tailgateOpen = OPEN_LABELS.has(e.tailgate_label);
        }

        if (climate && climate.climate) {
            const cl = climate.climate;
            s.climateOn = CLIMATE_ON_LABELS.has(cl.running_status_label);
            if (typeof cl.current_temp === 'number' && Number.isFinite(cl.current_temp) && cl.current_temp !== 0) {
                s.cabinTemp = Math.round(cl.current_temp * 10) / 10;
            }
        }

        if (health && health.health) {
            const h = health.health;
            s.tyreWarning = ['front_left', 'front_right', 'rear_left', 'rear_right']
                .some((side) => TYRE_WARNING_LABELS.has(h[`${side}_tyre_pressure_warning_label`]));
            s.serviceWarning = !!h.service_warning_label && !['UNSPECIFIED', 'NO_WARNING'].includes(h.service_warning_label);
        }

        const anyOk = [battery, exterior, climate].some((r) => r && typeof r === 'object');
        if (!anyOk && [battery, exterior, climate].every((r) => r === undefined)) {
            throw new Error('geen enkele status opgehaald');
        }
        if (anyOk) s.lastOk = Date.now();

        this.pushState();
        this.log.debug(`Status: batterij ${s.batteryLevel}% (${s.rangeKm} km), laden=${s.charging}, stekker=${s.chargerConnected}, ` +
            `slot=${s.locked}, portieren open=${s.doorsOpen}, ramen open=${s.windowsOpen}, achterklep open=${s.tailgateOpen}, ` +
            `klimaat=${s.climateOn} (${s.cabinTemp} °C), voorconditionering=${s.preconditioning}`);
    }

    pushState() {
        const { Service, Characteristic } = this.hap;
        const s = this.state;
        for (const acc of this.accessories.values()) {
            const lock = acc.getService(Service.LockMechanism);
            if (lock) {
                lock.updateCharacteristic(Characteristic.LockCurrentState, this.lockCurrentState());
                lock.updateCharacteristic(Characteristic.LockTargetState, this.lockTargetState());
            }
            const bat = acc.getService(Service.Battery);
            if (bat && s.batteryLevel != null) {
                bat.updateCharacteristic(Characteristic.BatteryLevel, s.batteryLevel);
                bat.updateCharacteristic(Characteristic.ChargingState, this.chargingState());
                bat.updateCharacteristic(Characteristic.StatusLowBattery, this.lowBattery());
            }
            switch (acc.context.kind) {
                case 'charger':
                    acc.getService(Service.ContactSensor)
                        ?.updateCharacteristic(Characteristic.ContactSensorState, this.contact(s.chargerConnected));
                    break;
                case 'charge':
                    acc.getService(Service.Switch)?.updateCharacteristic(Characteristic.On, s.charging);
                    break;
                case 'climate':
                    acc.getService(Service.Switch)?.updateCharacteristic(Characteristic.On, s.climateOn);
                    break;
                case 'climate-thermostat': {
                    const t = acc.getService(Service.Thermostat);
                    if (!t) break;
                    const H = Characteristic.CurrentHeatingCoolingState;
                    const T = Characteristic.TargetHeatingCoolingState;
                    t.updateCharacteristic(H, s.climateOn ? H.HEAT : H.OFF);
                    t.updateCharacteristic(T, s.climateOn ? T.AUTO : T.OFF);
                    if (s.cabinTemp != null) t.updateCharacteristic(Characteristic.CurrentTemperature, s.cabinTemp);
                    break;
                }
                case 'openings':
                    acc.getServiceById(Service.ContactSensor, 'doors')
                        ?.updateCharacteristic(Characteristic.ContactSensorState, this.contact(!s.doorsOpen));
                    acc.getServiceById(Service.ContactSensor, 'windows')
                        ?.updateCharacteristic(Characteristic.ContactSensorState, this.contact(!s.windowsOpen));
                    acc.getServiceById(Service.ContactSensor, 'tailgate')
                        ?.updateCharacteristic(Characteristic.ContactSensorState, this.contact(!s.tailgateOpen));
                    break;
                case 'warnings': {
                    const O = Characteristic.OccupancyDetected;
                    acc.getServiceById(Service.OccupancySensor, 'tyres')
                        ?.updateCharacteristic(O, s.tyreWarning ? O.OCCUPANCY_DETECTED : O.OCCUPANCY_NOT_DETECTED);
                    acc.getServiceById(Service.OccupancySensor, 'service')
                        ?.updateCharacteristic(O, s.serviceWarning ? O.OCCUPANCY_DETECTED : O.OCCUPANCY_NOT_DETECTED);
                    break;
                }
                default:
                    break;
            }
        }
    }

    // ---------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------

    /** onGet-wrapper: snel uit cache; "Geen reactie" als er nooit (of al lang niet) data is. */
    read(fn) {
        const normal = Math.max(2, Number(this.config.pollIntervalMinutes) || 10);
        const stale = Date.now() - this.state.lastOk > Math.max(60, normal * 4) * 60 * 1000;
        if (!this.state.lastOk || stale) {
            throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        return fn();
    }

    contact(detected) {
        const C = this.hap.Characteristic.ContactSensorState;
        return detected ? C.CONTACT_DETECTED : C.CONTACT_NOT_DETECTED;
    }

    chargingState() {
        const C = this.hap.Characteristic.ChargingState;
        return this.state.charging ? C.CHARGING : C.NOT_CHARGING;
    }

    lowBattery() {
        const C = this.hap.Characteristic.StatusLowBattery;
        const threshold = Number(this.config.lowBatteryThreshold) || 20;
        return this.state.batteryLevel != null && this.state.batteryLevel < threshold
            ? C.BATTERY_LEVEL_LOW : C.BATTERY_LEVEL_NORMAL;
    }

    lockCurrentState() {
        const C = this.hap.Characteristic.LockCurrentState;
        if (this.state.locked === null) return C.UNKNOWN;
        return this.state.locked ? C.SECURED : C.UNSECURED;
    }

    lockTargetState() {
        const T = this.hap.Characteristic.LockTargetState;
        return this.state.locked === false ? T.UNSECURED : T.SECURED;
    }

    targetTemperature() {
        const t = this.state.climateTarget ?? Number(this.config.climateTemperature);
        return Number.isFinite(t) && t >= 16 && t <= 28 ? t : 21;
    }

    async setClimate(on) {
        const temperature = this.targetTemperature();
        await this.command(on ? `klimaat starten (${temperature} °C)` : 'klimaat stoppen', 'climate',
            () => (on ? this.client.climateStart({ temperature }) : this.client.climateStop()));
        this.state.climateOn = on;
        if (on) this.scheduleNextPoll(); // sneller pollen
    }

    async command(label, key, fn, { refresh = true } = {}) {
        const { HapStatusError, HAPStatus } = this.hap;
        if (this.config.disableWrites === true) {
            this.log.warn(`Commando '${label}' geblokkeerd: schrijfacties staan uit in de config.`);
            throw new HapStatusError(HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
        }
        if (!this.client || !this.vehicle) {
            throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        try {
            const result = await fn();
            if (result && result.ok === false) {
                throw new Error(result.message || `status ${result.statusLabel || result.status}`);
            }
            this.log.info(`Commando '${label}' verstuurd${result && result.statusLabel ? ` (${result.statusLabel})` : ''}.`);
            if (refresh) {
                const t = setTimeout(() => this.refresh().catch(() => {}), 20 * 1000);
                t.unref && t.unref();
            }
            return result;
        } catch (err) {
            if (isUnimplemented(err)) this.unsupported.add(`cmd:${key}`);
            this.log.error(`Commando '${label}' mislukt: ${friendlyError(err)}`);
            throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }
}

module.exports = { PolestarPlatform, PLATFORM_NAME, PLUGIN_NAME, friendlyError, isUnimplemented };
