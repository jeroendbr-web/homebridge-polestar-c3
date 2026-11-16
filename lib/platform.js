'use strict';

const { PolestarC3 } = require('./polestar-c3/client');

const PLUGIN_NAME = 'homebridge-polestar-c3';
const PLATFORM_NAME = 'PolestarC3';

// Enum labels from lib/polestar-c3/messages.js
const CHARGING = 'CHARGING';
const SMART_CHARGING = 'SMART_CHARGING';
const CHARGER_CONNECTED = 'CONNECTED';
const LOCKED = 'LOCKED';
const CLIMATE_ACTIVE = 'ACTIVE';
const CLIMATE_STARTING = 'START_ATTEMPT';

class PolestarPlatform {
    constructor(log, config, api) {
        this.log = log;
        this.config = config || {};
        this.api = api;
        this.accessories = new Map(); // uuid -> PlatformAccessory (restored from cache)

        this.client = null;
        this.vehicle = null;

        // Last known state, refreshed by the poller
        this.state = {
            batteryLevel: null,
            charging: false,
            chargerConnected: false,
            locked: null,
            climateOn: false,
        };

        if (!this.config.email || !this.config.password) {
            this.log.error('Geen email/wachtwoord geconfigureerd — plugin start niet.');
            return;
        }

        this.api.on('didFinishLaunching', () => {
            this.start().catch((err) => {
                this.log.error('Opstarten mislukt:', err.message);
            });
        });
    }

    // Homebridge restores cached accessories through this hook
    configureAccessory(accessory) {
        this.accessories.set(accessory.UUID, accessory);
    }

    async start() {
        this.log.info('Inloggen bij Polestar ID...');
        this.client = new PolestarC3(this.config.email, this.config.password);
        await this.client.login();

        const vehicles = await this.client.listVehicles();
        if (!vehicles || vehicles.length === 0) {
            throw new Error('Geen voertuigen gevonden op dit Polestar-account. Vul eventueel het VIN handmatig in.');
        }

        const wantedVin = (this.config.vin || '').trim().toUpperCase();
        this.vehicle = wantedVin
            ? vehicles.find((v) => (v.vin || '').toUpperCase() === wantedVin) || { vin: wantedVin }
            : vehicles[0];

        await this.client.setVehicle(this.vehicle.vin);
        const model = (this.vehicle.content && this.vehicle.content.model && this.vehicle.content.model.name) || 'Polestar';
        this.log.info(`Verbonden met ${model} (${this.vehicle.vin})`);

        this.setupAccessories(model);

        // First refresh immediately, then on the configured interval
        await this.refresh();
        const minutes = Math.max(2, Number(this.config.pollIntervalMinutes) || 10);
        this.log.info(`Status wordt elke ${minutes} minuten ververst.`);
        const timer = setInterval(() => {
            this.refresh().catch((err) => this.log.warn('Verversen mislukt:', err.message));
        }, minutes * 60 * 1000);
        timer.unref && timer.unref();
    }

    // ---------------------------------------------------------------
    // Accessory setup
    // ---------------------------------------------------------------

    setupAccessories(model) {
        const { Service, Characteristic } = this.api.hap;
        const wanted = [];

        // 1. Lock + battery (battery is attached to the lock tile)
        if (this.config.enableLock !== false) {
            wanted.push(this.ensureAccessory(`${model} Slot`, 'lock', (acc) => {
                const lock = acc.getService(Service.LockMechanism)
                    || acc.addService(Service.LockMechanism, `${model} Slot`);

                lock.getCharacteristic(Characteristic.LockCurrentState)
                    .onGet(() => this.lockCurrentState());

                lock.getCharacteristic(Characteristic.LockTargetState)
                    .onGet(() => this.lockCurrentState() === Characteristic.LockCurrentState.UNSECURED
                        ? Characteristic.LockTargetState.UNSECURED
                        : Characteristic.LockTargetState.SECURED)
                    .onSet(async (value) => {
                        const secure = value === Characteristic.LockTargetState.SECURED;
                        await this.command(secure ? 'vergrendelen' : 'ontgrendelen',
                            () => secure ? this.client.lock() : this.client.unlock());
                        this.state.locked = secure;
                        lock.updateCharacteristic(Characteristic.LockCurrentState, this.lockCurrentState());
                    });

                const battery = acc.getService(Service.Battery) || acc.addService(Service.Battery);
                battery.getCharacteristic(Characteristic.BatteryLevel)
                    .onGet(() => this.state.batteryLevel == null ? 0 : this.state.batteryLevel);
                battery.getCharacteristic(Characteristic.ChargingState)
                    .onGet(() => this.state.charging
                        ? Characteristic.ChargingState.CHARGING
                        : Characteristic.ChargingState.NOT_CHARGING);
                battery.getCharacteristic(Characteristic.StatusLowBattery)
                    .onGet(() => (this.state.batteryLevel != null && this.state.batteryLevel < 20)
                        ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
                        : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
            }));
        }

        // 2. Climate as a simple switch
        if (this.config.enableClimate !== false) {
            wanted.push(this.ensureAccessory(`${model} Klimaat`, 'climate', (acc) => {
                const sw = acc.getService(Service.Switch)
                    || acc.addService(Service.Switch, `${model} Klimaat`);
                sw.getCharacteristic(Characteristic.On)
                    .onGet(() => this.state.climateOn)
                    .onSet(async (on) => {
                        const temperature = Number(this.config.climateTemperature) || 21;
                        await this.command(on ? 'klimaat starten' : 'klimaat stoppen',
                            () => on ? this.client.climateStart({ temperature }) : this.client.climateStop());
                        this.state.climateOn = !!on;
                    });
            }));
        }

        // 3. Charger-connected contact sensor (nice for automations)
        if (this.config.enableChargerSensor !== false) {
            wanted.push(this.ensureAccessory(`${model} Lader`, 'charger', (acc) => {
                const sensor = acc.getService(Service.ContactSensor)
                    || acc.addService(Service.ContactSensor, `${model} Lader`);
                sensor.getCharacteristic(Characteristic.ContactSensorState)
                    .onGet(() => this.state.chargerConnected
                        ? Characteristic.ContactSensorState.CONTACT_DETECTED
                        : Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
            }));
        }

        // 4. Optional charging override switch (only overrides an active schedule)
        if (this.config.enableChargeSwitch === true) {
            wanted.push(this.ensureAccessory(`${model} Laden`, 'charge', (acc) => {
                const sw = acc.getService(Service.Switch)
                    || acc.addService(Service.Switch, `${model} Laden`);
                sw.getCharacteristic(Characteristic.On)
                    .onGet(() => this.state.charging)
                    .onSet(async (on) => {
                        await this.command(on ? 'laden starten' : 'laden stoppen',
                            () => on ? this.client.chargeStart() : this.client.chargeStop());
                    });
            }));
        }

        // Remove cached accessories that are no longer wanted
        const wantedUuids = new Set(wanted);
        for (const [uuid, acc] of this.accessories) {
            if (!wantedUuids.has(uuid)) {
                this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
                this.accessories.delete(uuid);
            }
        }
    }

    ensureAccessory(displayName, kind, configure) {
        const { Service, Characteristic } = this.api.hap;
        const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${this.vehicle.vin}:${kind}`);
        let acc = this.accessories.get(uuid);
        const isNew = !acc;
        if (isNew) {
            acc = new this.api.platformAccessory(displayName, uuid);
        }
        const info = acc.getService(Service.AccessoryInformation);
        info.setCharacteristic(Characteristic.Manufacturer, 'Polestar (onofficieel)')
            .setCharacteristic(Characteristic.Model, displayName)
            .setCharacteristic(Characteristic.SerialNumber, this.vehicle.vin);
        configure(acc);
        if (isNew) {
            this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
            this.accessories.set(uuid, acc);
        }
        return uuid;
    }

    // ---------------------------------------------------------------
    // State refresh + helpers
    // ---------------------------------------------------------------

    async refresh() {
        const { Service, Characteristic } = this.api.hap;

        const battery = await this.client.getLatestBattery().catch(() => null);
        if (battery && battery.battery) {
            const b = battery.battery;
            this.state.batteryLevel = Math.max(0, Math.min(100, Number(b.charge_level) || 0));
            this.state.charging = b.charging_status_label === CHARGING || b.charging_status_label === SMART_CHARGING;
            this.state.chargerConnected = b.charger_connection_status_label === CHARGER_CONNECTED;
        }

        const exterior = await this.client.getLatestExterior().catch(() => null);
        if (exterior && exterior.exterior) {
            this.state.locked = exterior.exterior.central_lock_label === LOCKED;
        }

        const climate = await this.client.getLatestClimate().catch(() => null);
        if (climate && climate.climate) {
            const label = climate.climate.running_status_label;
            this.state.climateOn = label === CLIMATE_ACTIVE || label === CLIMATE_STARTING;
        }

        // Push fresh values to HomeKit
        for (const acc of this.accessories.values()) {
            const lock = acc.getService(Service.LockMechanism);
            if (lock) {
                lock.updateCharacteristic(Characteristic.LockCurrentState, this.lockCurrentState());
                lock.updateCharacteristic(Characteristic.LockTargetState,
                    this.lockCurrentState() === Characteristic.LockCurrentState.UNSECURED
                        ? Characteristic.LockTargetState.UNSECURED
                        : Characteristic.LockTargetState.SECURED);
            }
            const bat = acc.getService(Service.Battery);
            if (bat && this.state.batteryLevel != null) {
                bat.updateCharacteristic(Characteristic.BatteryLevel, this.state.batteryLevel);
                bat.updateCharacteristic(Characteristic.ChargingState, this.state.charging
                    ? Characteristic.ChargingState.CHARGING
                    : Characteristic.ChargingState.NOT_CHARGING);
            }
            const contact = acc.getService(Service.ContactSensor);
            if (contact) {
                contact.updateCharacteristic(Characteristic.ContactSensorState, this.state.chargerConnected
                    ? Characteristic.ContactSensorState.CONTACT_DETECTED
                    : Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
            }
            const sw = acc.getService(Service.Switch);
            if (sw) {
                const isCharge = acc.displayName.endsWith('Laden');
                sw.updateCharacteristic(Characteristic.On, isCharge ? this.state.charging : this.state.climateOn);
            }
        }

        this.log.debug(`Status: batterij ${this.state.batteryLevel}%, laden=${this.state.charging}, ` +
            `stekker=${this.state.chargerConnected}, slot=${this.state.locked}, klimaat=${this.state.climateOn}`);
    }

    lockCurrentState() {
        const { Characteristic } = this.api.hap;
        if (this.state.locked === null) return Characteristic.LockCurrentState.UNKNOWN;
        return this.state.locked
            ? Characteristic.LockCurrentState.SECURED
            : Characteristic.LockCurrentState.UNSECURED;
    }

    async command(label, fn) {
        if (this.config.disableWrites === true) {
            this.log.warn(`Commando '${label}' geblokkeerd: schrijfacties staan uit in de config.`);
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
        }
        try {
            const result = await fn();
            if (result && result.ok === false) {
                throw new Error(result.message || `status ${result.statusLabel || result.status}`);
            }
            this.log.info(`Commando '${label}' verstuurd.`);
            // Refresh shortly after, so HomeKit reflects the real outcome
            setTimeout(() => this.refresh().catch(() => {}), 20 * 1000);
            return result;
        } catch (err) {
            this.log.error(`Commando '${label}' mislukt: ${err.message}`);
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }
}

module.exports = { PolestarPlatform, PLATFORM_NAME, PLUGIN_NAME };
