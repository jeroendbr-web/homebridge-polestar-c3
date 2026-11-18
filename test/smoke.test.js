'use strict';
// Smoke test: real HAP-NodeJS, fake Polestar client. Run with `npm test`.
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

async function loadHap() { return (await import('@homebridge/hap-nodejs')); }

function makeApi(hap, storage) {
    const api = new EventEmitter();
    class PlatformAccessory {
        constructor(name, uuid, category) {
            this._a = new hap.Accessory(name, uuid);
            this._a.category = category;
            this.UUID = uuid; this.displayName = name; this.context = {};
        }
        getService(t) { return this._a.getService(t); }
        getServiceById(t, s) { return this._a.getServiceById(t, s); }
        addService(...a) { return this._a.addService(...a); }
        get services() { return this._a.services; }
    }
    Object.assign(api, {
        hap, platformAccessory: PlatformAccessory, registered: [], unregistered: [],
        user: { storagePath: () => storage },
        registerPlatformAccessories: (p, n, accs) => api.registered.push(...accs),
        unregisterPlatformAccessories: (p, n, accs) => api.unregistered.push(...accs),
        updatePlatformAccessories: () => {},
    });
    return api;
}

const log = Object.assign((...a) => {}, { info() {}, warn() {}, error() {}, debug() {} });

function fakeClient(calls) {
    return {
        login: async () => {}, close() {},
        listVehicles: async () => [{ vin: 'YSMTEST0000000001', content: { model: { name: 'Polestar 3' } } }],
        setVehicle: async () => {},
        getOtaSoftwareInfo: async () => ({ current: { version: 'P3.2.1' }, update_available: false }),
        getLatestBattery: async () => ({ battery: { charge_level: 81.6, range_km: 402, charging_status_label: 'CHARGING', charger_connection_status_label: 'CONNECTED' } }),
        getLatestExterior: async () => ({ exterior: { central_lock_label: 'LOCKED', door_front_left_label: 'OPEN', tailgate_label: 'CLOSED' } }),
        getLatestClimate: async () => { throw new Error('gRPC x status=12 (UNIMPLEMENTED) message="nope"'); },
        getLatestHealth: async () => ({ health: { front_left_tyre_pressure_warning_label: 'LOW_PRESSURE', service_warning_label: 'NO_WARNING' } }),
        lock: async () => { calls.push('lock'); return { ok: true, statusLabel: 'SENT' }; },
        unlock: async () => { calls.push('unlock'); return { ok: true, statusLabel: 'SENT' }; },
        climateStart: async (o) => { calls.push(['climateStart', o.temperature]); return { ok: true }; },
        climateStop: async () => ({ ok: true }),
        honkFlash: async (o) => { calls.push(['honk', o.action]); return { ok: true }; },
    };
}

test('platform setup, accessories and commands', async () => {
    const hap = await loadHap();
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-'));
    const api = makeApi(hap, storage);
    const { PolestarPlatform } = require('../lib/platform');
    const calls = [];
    const p = new PolestarPlatform(log, { email: 'a@b.c', password: 'x', climateAccessory: 'thermostat',
        enableWarnings: true, enableHonkFlash: true, climateTemperature: 22.5 }, api);
    const client = fakeClient(calls);
    p.client = client; // skip start(): no real login
    const { Service: S, Characteristic: C } = hap;
    p.vehicle = { vin: 'YSMTEST0000000001' }; p.model = 'Polestar 3';
    p.setupAccessories();
    await p.refresh();

    const kinds = api.registered.map((a) => a.context.kind).sort();
    assert.deepStrictEqual(kinds, ['charger', 'climate-thermostat', 'honkflash', 'lock', 'openings', 'warnings']);

    const byKind = (k) => api.registered.find((a) => a.context.kind === k);
    const lock = byKind('lock').getService(S.LockMechanism);
    assert.strictEqual(lock.getCharacteristic(C.LockCurrentState).value, C.LockCurrentState.SECURED);
    const bat = byKind('lock').getService(S.Battery);
    assert.strictEqual(bat.getCharacteristic(C.BatteryLevel).value, 82);
    assert.strictEqual(bat.getCharacteristic(C.ChargingState).value, C.ChargingState.CHARGING);
    const doors = byKind('openings').getServiceById(S.ContactSensor, 'doors');
    assert.strictEqual(doors.getCharacteristic(C.ContactSensorState).value, C.ContactSensorState.CONTACT_NOT_DETECTED);
    const tyres = byKind('warnings').getServiceById(S.OccupancySensor, 'tyres');
    assert.strictEqual(tyres.getCharacteristic(C.OccupancyDetected).value, 1);
    assert.ok(p.unsupported.has('climate'));

    // onGet through HAP
    assert.strictEqual(await bat.getCharacteristic(C.BatteryLevel).handleGetRequest(), 82);

    // commands
    await lock.getCharacteristic(C.LockTargetState).handleSetRequest(C.LockTargetState.UNSECURED);
    const th = byKind('climate-thermostat').getService(S.Thermostat);
    await th.getCharacteristic(C.TargetHeatingCoolingState).handleSetRequest(C.TargetHeatingCoolingState.AUTO);
    await byKind('honkflash').getService(S.Switch).getCharacteristic(C.On).handleSetRequest(true);
    assert.deepStrictEqual(calls, ['unlock', ['climateStart', 22.5], ['honk', 2]]);

    // kill switch
    p.config.disableWrites = true;
    await assert.rejects(lock.getCharacteristic(C.LockTargetState).handleSetRequest(C.LockTargetState.SECURED));

    // session persistence
    p.saveSession({ refresh_token: 'rt', access_token: 'secret', obtained_at: 1 });
    const saved = p.loadSession();
    assert.strictEqual(saved.refresh_token, 'rt');
    assert.strictEqual(saved.access_token, undefined);

    p.shutdown();
});

test('does not start without config', async () => {
    const hap = await loadHap();
    const api = makeApi(hap, os.tmpdir());
    const { PolestarPlatform } = require('../lib/platform');
    const p = new PolestarPlatform(log, {}, api);
    assert.strictEqual(api.listenerCount('didFinishLaunching'), 0);
    p.shutdown();
});

test('retries once after a cancelled stream (GOAWAY)', async () => {
    const hap = await loadHap();
    const api = makeApi(hap, fs.mkdtempSync(path.join(os.tmpdir(), 'hb-')));
    const { PolestarPlatform } = require('../lib/platform');
    const p = new PolestarPlatform(log, { email: 'a@b.c', password: 'x' }, api);
    const client = fakeClient([]);
    let batteryCalls = 0;
    const realBattery = client.getLatestBattery;
    client.getLatestBattery = async () => {
        batteryCalls++;
        if (batteryCalls === 1) throw new Error('The pending stream has been canceled (caused by: GOAWAY)');
        return realBattery();
    };
    client.getLatestExterior = async () => { throw new Error('session destroyed'); };
    p.client = client;
    p.vehicle = { vin: 'YSMTEST0000000001' }; p.model = 'Polestar 3';
    p.setupAccessories();
    await p.refresh();
    assert.strictEqual(batteryCalls, 2);
    assert.strictEqual(p.state.batteryLevel, 82);
    assert.ok(p.state.lastOk > 0);

    // everything failing → error that includes the reason
    client.getLatestBattery = async () => { throw new Error('session destroyed'); };
    await assert.rejects(p.refresh(), /no status could be read \(session destroyed\)/);
    p.shutdown();
});

test('client routes its messages to the Homebridge logger', () => {
    const { PolestarC3 } = require('../lib/polestar-c3/client');
    const seen = [];
    const c = new PolestarC3('a@b.c', 'x', { logger: { debug: (m) => seen.push(['debug', m]), warn: (m) => seen.push(['warn', m]) } });
    c._log('debug', 'goaway');
    c._log('warn', 'ping failed');
    assert.deepStrictEqual(seen, [['debug', 'goaway'], ['warn', 'ping failed']]);
});

test('compressed gRPC frames are rejected, not thrown from an event handler', async () => {
    const { parseFrames } = require('../lib/polestar-c3/grpc');
    const frame = Buffer.from([1, 0, 0, 0, 1, 0x42]); // compressed flag set
    assert.throws(() => parseFrames(frame), /Compressed/);
    const src = fs.readFileSync(path.join(__dirname, '../lib/polestar-c3/grpc.js'), 'utf8');
    assert.ok(!/accept-encoding': 'identity,gzip'/.test(src));
    assert.ok(/try \{\s*frames = parseFrames\(body\);/.test(src));
});
