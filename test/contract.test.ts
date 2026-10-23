import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHaritoraX } from "../dist/index.js";
import type { Connection, Frame, ListOptions } from "../dist/connections/contract.js";
import { fromByteArray as encodeBase64, toByteArray as decodeBase64 } from "base64-js";
import type { BatteryInfo, EndpointDescriptor, DisconnectReason, Unsubscribe } from "../dist/types.js";

/** In-memory connection: the reference implementation of the contract. */
function memoryConnection(endpoints: string[] = ["COM4"]) {
    const dataHandlers = new Set<(frame: Frame) => void>();
    const lostHandlers = new Set<(endpointId: string, reason: DisconnectReason) => void>();
    const opened = new Set<string>();

    const connection = {
        kind: "serial" as const,
        opened,

        list(_options?: ListOptions): Promise<EndpointDescriptor[]> {
            return Promise.resolve(
                endpoints.map((id) => ({ id, connection: "serial" as const, displayName: id, dongle: "GX6" as const })),
            );
        },

        open(endpointId: string): Promise<void> {
            if (!endpoints.includes(endpointId)) return Promise.reject(new Error("DEVICE_NOT_FOUND"));
            opened.add(endpointId);
            return Promise.resolve();
        },

        close(endpointId: string): Promise<void> {
            opened.delete(endpointId);
            return Promise.resolve();
        },

        write(_endpointId: string, _data: Uint8Array): Promise<void> {
            return Promise.resolve();
        },

        onData(handler: (frame: Frame) => void): Unsubscribe {
            dataHandlers.add(handler);
            return () => dataHandlers.delete(handler);
        },

        onLost(handler: (endpointId: string, reason: DisconnectReason) => void): Unsubscribe {
            lostHandlers.add(handler);
            return () => lostHandlers.delete(handler);
        },

        dispose(): Promise<void> {
            dataHandlers.clear();
            lostHandlers.clear();
            opened.clear();
            return Promise.resolve();
        },

        /** Test helpers. */
        emitFrame(endpointId: string, text: string): void {
            const data = new Uint8Array([...text].map((character) => character.charCodeAt(0)));
            for (const handler of dataHandlers) handler({ endpointId, data });
        },

        emitLost(endpointId: string, reason: DisconnectReason): void {
            for (const handler of lostHandlers) handler(endpointId, reason);
        },
    };

    return connection;
}

describe("connection contract", () => {
    it("accepts injected connection instances", () => {
        const connection = memoryConnection();
        const app = createHaritoraX({ connections: [connection], logLevel: "silent" });

        assert.deepEqual(app.getDevices(), []);
        assert.equal(connection.kind, "serial");
    });

    it("accepts no connections at all", () => {
        const app = createHaritoraX({ logLevel: "silent" });
        assert.deepEqual(app.getDevices(), []);
    });

    it("emits log events alongside the onLog sink", async () => {
        const logs: string[] = [];
        const app = createHaritoraX({ connections: [memoryConnection()], logLevel: "info", onLog: () => {} });
        app.on("log", (entry) => logs.push(entry.message));

        await app.discover();
        await app.dispose();

        assert.ok(logs.some((message) => message.startsWith("Discovered")));
    });
});

describe("container discovery and connection", () => {
    it("returns endpoints from every injected connection", async () => {
        const a = memoryConnection(["COM4"]);
        const b = memoryConnection(["COM5"]);
        const app = createHaritoraX({ connections: [a, b], logLevel: "silent" });

        const found = await app.discover();

        assert.deepEqual(
            found.map((descriptor) => descriptor.id),
            ["COM4", "COM5"],
        );
        assert.deepEqual(
            app.getEndpoints().map((descriptor) => descriptor.id),
            ["COM4", "COM5"],
        );
    });

    it("does not fail discovery when one connection throws", async () => {
        const broken: Connection = {
            kind: "bluetooth-le",
            list: () => Promise.reject(new Error("no adapter")),
            open: () => Promise.resolve(),
            close: () => Promise.resolve(),
            write: () => Promise.resolve(),
            onData: () => () => {},
            onLost: () => () => {},
            dispose: () => Promise.resolve(),
        };

        const working = memoryConnection(["COM4"]);
        const app = createHaritoraX({ connections: [broken, working], logLevel: "silent" });

        const errors: string[] = [];
        app.on("error", ({ error }) => errors.push(error.message));

        const found = await app.discover();

        assert.deepEqual(
            found.map((descriptor) => descriptor.id),
            ["COM4"],
        );
        assert.deepEqual(errors, ["no adapter"]);
    });

    it("connects through the connection that discovered the endpoint", async () => {
        const serial = memoryConnection(["COM4"]);
        const app = createHaritoraX({ connections: [serial], logLevel: "silent" });

        const connected: string[] = [];
        app.on("endpoint:connected", ({ endpointId }) => connected.push(endpointId));

        await app.discover();
        await app.connect("COM4");

        assert.deepEqual([...serial.opened], ["COM4"]);
        assert.deepEqual(connected, ["COM4"]);
    });

    it("refuses to connect an endpoint it has not discovered", async () => {
        const app = createHaritoraX({ connections: [memoryConnection()], logLevel: "silent" });

        const error = await app.connect("COM9").catch((err: unknown) => err);

        assert.equal((error as { code?: string }).code, "DEVICE_NOT_FOUND");
        assert.match((error as Error).message, /call discover\(\) first/);
    });

    it("disconnects with a requested reason", async () => {
        const serial = memoryConnection(["COM4"]);
        const app = createHaritoraX({ connections: [serial], logLevel: "silent" });

        const disconnects: Array<{ endpointId: string; reason: string }> = [];
        app.on("endpoint:disconnected", (event) => disconnects.push(event));

        await app.discover();
        await app.connect("COM4");
        await app.disconnect("COM4");

        assert.deepEqual(disconnects, [{ endpointId: "COM4", reason: "requested" }]);
        assert.equal(serial.opened.size, 0);
    });

    it("surfaces a connection loss as device:disconnected", async () => {
        const serial = memoryConnection(["COM4"]);
        const app = createHaritoraX({ connections: [serial], logLevel: "silent" });

        const disconnects: Array<{ endpointId: string; reason: string }> = [];
        app.on("endpoint:disconnected", (event) => disconnects.push(event));

        await app.discover();
        await app.connect("COM4");
        serial.emitLost("COM4", "remote");

        assert.deepEqual(disconnects, [{ endpointId: "COM4", reason: "remote" }]);
    });

    it("cancels discovery through stopDiscovery()", async () => {
        let receivedSignal: AbortSignal | undefined;

        const slow: Connection = {
            kind: "bluetooth-le",
            list: (options) => {
                receivedSignal = options?.signal;
                return new Promise((resolve) => {
                    options?.signal?.addEventListener("abort", () => resolve([]));
                });
            },
            open: () => Promise.resolve(),
            close: () => Promise.resolve(),
            write: () => Promise.resolve(),
            onData: () => () => {},
            onLost: () => () => {},
            dispose: () => Promise.resolve(),
        };

        const app = createHaritoraX({ connections: [slow], logLevel: "silent" });
        const pending = app.discover();

        await new Promise((resolve) => setTimeout(resolve, 5));
        await app.stopDiscovery();

        assert.deepEqual(await pending, []);
        assert.equal(receivedSignal?.aborted, true);
    });

    it("stops dispatching frames after dispose()", async () => {
        const serial = memoryConnection(["COM4"]);
        const app = createHaritoraX({ connections: [serial], logLevel: "silent" });

        const frames: string[] = [];
        app.on("imu", () => frames.push("imu"));

        await app.discover();
        await app.connect("COM4");
        await app.dispose();

        // The connection is disposed, so its handlers are cleared.
        serial.emitFrame("COM4", "X0:QQV1");
        assert.deepEqual(frames, []);
    });
});

describe("class contract", () => {
    it("dispose() is idempotent", async () => {
        const app = createHaritoraX({ logLevel: "silent" });
        await app.dispose();
        await app.dispose();
    });

    it("dispose() clears discovered state", async () => {
        const app = createHaritoraX({ connections: [memoryConnection(["COM4"])], logLevel: "silent" });

        await app.discover();
        assert.equal(app.getEndpoints().length, 1);

        await app.dispose();
        assert.deepEqual(app.getEndpoints(), []);
        assert.deepEqual(app.getDevices(), []);
    });

    it("isolates two containers", async () => {
        const a = createHaritoraX({ logLevel: "silent" });
        const b = createHaritoraX({ logLevel: "silent" });

        await a.dispose();
        assert.deepEqual(b.getDevices(), []);
    });
});

describe("protocol dispatch", () => {
    async function connected() {
        const serial = memoryConnection(["COM4"]);
        const app = createHaritoraX({ connections: [serial], logLevel: "silent" });
        await app.discover();
        await app.connect("COM4");
        return { app, serial };
    }

    it("creates a serial-keyed device from i0 and emits info", async () => {
        const { app, serial } = await connected();

        const infos: Array<{ deviceId: string; serialNumber: string; model: string }> = [];
        app.on("info", (info) => infos.push(info));

        serial.emitFrame("COM4", 'i0:{"version":"1.0.22","model":"mc3s","serial no":"A2E987"}');

        const device = app.getDevice("A2E987");
        assert.ok(device);
        assert.equal(device.endpointId, "COM4");
        assert.equal(device.slot, "0");
        assert.equal(device.imuCount, 1);
        assert.deepEqual(
            device.trackers.map((tracker) => tracker.trackerId),
            ["A2E987:0"],
        );
        assert.equal(device.trackers[0]?.bodyPart, "unassigned");
        assert.equal(device.connection, "serial");
        assert.equal(infos[0]?.deviceId, "A2E987");
        assert.equal(infos[0]?.serialNumber, "A2E987");
        assert.equal(infos[0]?.model, "mc3s");
    });

    it("marks a dual-IMU device from imu_num", async () => {
        const { app, serial } = await connected();

        serial.emitFrame("COM4", 'i0:{"version":"0.0.1","model":"mc4b","imu_num":2,"serial no":"A2E987"}');

        const device = app.getDevice("A2E987");
        assert.equal(device?.imuCount, 2);
        assert.deepEqual(
            device?.trackers.map((tracker) => tracker.trackerId),
            ["A2E987:0", "A2E987:1"],
        );
        assert.equal(device?.model, "x2");
    });

    it("identifies HX2 from the firmware model, even with one IMU", async () => {
        // Live hardware: HX2 reports mc4b, HaritoraX Wireless reports mc3s.
        const { app, serial } = await connected();

        serial.emitFrame("COM4", 'i0:{"version":"1.0.5","model":"mc4b","imu_num":1,"serial no":"C1MGN3"}');
        serial.emitFrame("COM4", 'i1:{"version":"1.0.22","model":"mc3s","imu_num":1,"serial no":"A2E987"}');

        assert.equal(app.getDevice("C1MGN3")?.model, "x2");
        assert.equal(app.getDevice("A2E987")?.model, "wireless");
    });

    it("ignores the placeholder reply from an empty slot", async () => {
        // Empty slots answer with serial A00000 / version 0.0.1, which never
        // belongs to real hardware. Battery and settings frames arrive for them
        // too and must not create a device either.
        const { app, serial } = await connected();

        serial.emitFrame("COM4", 'i1:{"version":"0.0.1","model":"mc3s","imu_num":1,"serial no":"A00000"}');
        serial.emitFrame("COM4", 'v1:{"battery voltage":3000,"battery remaining":0,"charge status":"Unknown"}');
        serial.emitFrame("COM4", "o1:00000100101000");

        assert.deepEqual(app.getDevices(), []);
    });

    it("drops IMU frames that arrive before info", async () => {
        const { app, serial } = await connected();

        const samples: string[] = [];
        app.on("imu", (sample) => samples.push(sample.trackerId));

        serial.emitFrame("COM4", "x0:QAV1/Is6EBngAaf/bAkCAA==");

        assert.deepEqual(samples, []);
        assert.deepEqual(app.getDevices(), []);
    });

    it("emits tracker-scoped IMU samples", async () => {
        const { app, serial } = await connected();

        serial.emitFrame("COM4", 'i0:{"version":"1.0.22","model":"mc3s","serial no":"A2E987"}');

        const samples: Array<{ trackerId: string; deviceId: string; role: string; rotation: { x: number } }> = [];
        app.on("imu", (sample) => samples.push(sample));
        const mags: Array<{ trackerId: string }> = [];
        app.on("mag", (event) => mags.push(event));

        serial.emitFrame("COM4", "x0:QAV1/Is6EBngAaf/bAkCAA==");

        assert.equal(samples.length, 1);
        assert.equal(samples[0]?.trackerId, "A2E987:0");
        assert.equal(samples[0]?.deviceId, "A2E987");
        assert.equal(samples[0]?.role, "ankle");
        assert.ok(Math.abs((samples[0]?.rotation.x ?? 0) - 0.07466666666666667) < 1e-12);
        assert.deepEqual(mags, [{ trackerId: "A2E987:0", deviceId: "A2E987", status: "okay" }]);
    });

    it("splits a leg combo into ankle and knee samples", async () => {
        const { app, serial } = await connected();

        serial.emitFrame("COM4", 'i0:{"version":"0.0.1","model":"mc3s","imu_num":2,"serial no":"A2E987"}');

        const leg = decodeBase64("QAV1/Is6EBngAaf/bAkCAA==");
        const combo = new Uint8Array(30);
        combo.set(leg.slice(0, 14), 0);
        combo[14] = 3; // leg mag
        combo[15] = 1; // thigh mag
        combo.set(leg.slice(0, 14), 16);

        const samples: Array<{ trackerId: string; role: string; bodyPart: string }> = [];
        app.on("imu", (sample) => samples.push(sample));

        serial.emitFrame("COM4", `x0:${encodeBase64(combo)}`);

        assert.deepEqual(
            samples.map((sample) => sample.role),
            ["ankle", "knee"],
        );
        assert.deepEqual(
            samples.map((sample) => sample.trackerId),
            ["A2E987:0", "A2E987:1"],
        );
        assert.equal(samples[0]?.bodyPart, "unassigned");
    });

    it("updates battery and settings", async () => {
        const { app, serial } = await connected();

        const batteries: BatteryInfo[] = [];
        app.on("battery", (battery) => batteries.push(battery));

        serial.emitFrame("COM4", 'i0:{"version":"1.0.22","model":"mc3s","serial no":"A2E987"}');
        serial.emitFrame("COM4", 'v0:{"battery voltage":4105,"battery remaining":94,"charge status":"Discharging"}');
        serial.emitFrame("COM4", "o0:00000110101000");

        assert.equal(batteries[0]?.deviceId, "A2E987");
        assert.equal(batteries[0]?.level, 94);
        assert.equal(batteries[0]?.voltage, 4105);
        assert.equal(batteries[0]?.chargeStatus, "discharging");
        assert.deepEqual(app.getDevice("A2E987")?.settings, {
            sensorMode: 1,
            fpsMode: 100,
            sensorAutoCorrection: ["accel"],
            ankleMotionDetection: false,
        });
    });

    it("drops devices when the endpoint disconnects", async () => {
        const { app, serial } = await connected();

        serial.emitFrame("COM4", 'i0:{"model":"mc3s","serial no":"A2E987"}');
        assert.equal(app.getDevices().length, 1);

        await app.disconnect("COM4");
        assert.deepEqual(app.getDevices(), []);
    });

    it("survives a malformed packet without throwing", async () => {
        const { app, serial } = await connected();

        serial.emitFrame("COM4", 'i0:{"model":"mc3s","serial no":"A2E987"}');
        serial.emitFrame("COM4", "x0:not-valid-base64!!");
        assert.equal(app.getDevices().length, 1);
    });
});
