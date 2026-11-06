import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import { describe, it, mock } from "node:test";
import { createHaritoraX, HaritoraXError } from "../dist/index.js";
import type { Connection, Frame } from "../dist/connections/contract.js";
import type { ConnectionErrorEvent, HaritoraXErrorEvent } from "../dist/types.js";
import { SerialConnection, type SerialPort } from "../dist/connections/serial/index.js";
import { createBleConnection } from "../dist/connections/ble/noble.js";

class Port extends EventEmitter implements SerialPort {
    isOpen = true;
    failure: Error | undefined;
    closeFailure: Error | undefined;
    write(_data: string, callback: (error?: Error | null) => void): void {
        callback(this.failure);
    }
    close(callback?: (error?: Error | null) => void): void {
        this.isOpen = false;
        this.emit("error", new Error("late native close error"));
        callback?.(this.closeFailure);
    }
}

function serial(port: Port, heartbeatIntervalMs = 0) {
    return new SerialConnection(
        {
            list: () => Promise.resolve([{ path: "COM3", vendorId: "1915", productId: "520f" }]),
            open: () => Promise.resolve(port),
        },
        { heartbeatIntervalMs, operationTimeoutMs: 30 },
    );
}

function customConnection() {
    const events = new EventEmitter();
    let frameHandler: ((frame: Frame) => void) | undefined;
    const connection: Connection = {
        kind: "serial",
        list: () => Promise.resolve([{ id: "COM3", connection: "serial", displayName: "GX2", dongle: "GX2" }]),
        open: () => Promise.resolve(),
        close: () => Promise.resolve(),
        write: () => Promise.resolve(),
        onData: (handler) => {
            frameHandler = handler;
            return () => {
                frameHandler = undefined;
            };
        },
        onLost: () => () => {},
        onError: (handler) => {
            events.on("failure", handler);
            return () => {
                events.off("failure", handler);
            };
        },
        dispose: () => Promise.resolve(),
    };
    return {
        connection,
        events,
        frame: (text: string) => frameHandler?.({ endpointId: "COM3", data: new TextEncoder().encode(text) }),
    };
}

describe("consumer error propagation", () => {
    it("forwards original errors and context and unsubscribes at disposal", async () => {
        const { connection, events } = customConnection();
        const app = createHaritoraX({ connections: [connection], logLevel: "silent" });
        const reports: HaritoraXErrorEvent[] = [];
        const stop = app.on("error", (event) => reports.push(event));
        const error = new HaritoraXError("WRITE_FAILED", "denied", { cause: new Error("EACCES") });
        const event: ConnectionErrorEvent = { error, connection: "serial", operation: "heartbeat", endpointId: "COM3" };
        events.emit("failure", event);
        assert.equal(reports[0]?.error, error);
        assert.deepEqual(reports[0], event);
        stop();
        events.emit("failure", event);
        assert.equal(reports.length, 1);
        await app.dispose();
        assert.equal(events.listenerCount("failure"), 0);
    });

    it("contains throwing and rejecting error listeners while other consumers still receive failures", async () => {
        const { connection, events } = customConnection();
        const app = createHaritoraX({ connections: [connection], logLevel: "silent" });
        app.on("error", () => {
            throw new Error("listener failure");
        });
        app.on("error", () => Promise.reject(new Error("async listener failure")));
        const reports: HaritoraXErrorEvent[] = [];
        app.on("error", (event) => reports.push(event));
        events.emit("failure", { error: new Error("native failure"), operation: "stream", connection: "serial" });
        await setImmediate();
        assert.equal(reports.length, 1);
        await app.dispose();
    });

    it("reports malformed frames with endpoint context and continues valid dispatch", async () => {
        const { connection, frame } = customConnection();
        const app = createHaritoraX({ connections: [connection], logLevel: "silent" });
        const reports: HaritoraXErrorEvent[] = [];
        app.on("error", (event) => reports.push(event));
        await app.discover();
        await app.connect("COM3");
        frame("i0:{broken");
        frame('i0:{"model":"mc3s","serial no":"ABC123"}');
        frame("x0:AAAA");
        assert.equal(reports.length, 2);
        assert.equal(reports[0]?.endpointId, "COM3");
        assert.equal(reports[0]?.identifier, "i0");
        assert.equal(reports[0]?.operation, "decode");
        assert.equal((reports[0]?.error as HaritoraXError).code, "DECODE_FAILED");
        assert.ok(app.getDevice("ABC123"));
        await app.dispose();
    });

    it("rejects disposal with all causes after cleaning every connection", async () => {
        const a = customConnection().connection;
        const b = customConnection().connection;
        const errors = [new Error("a"), new Error("b")];
        a.dispose = () => Promise.reject(errors[0]);
        b.dispose = () => Promise.reject(errors[1]);
        const app = createHaritoraX({ connections: [a, b], logLevel: "silent" });
        const disposal = app.dispose();
        await assert.rejects(
            disposal,
            (error: unknown) => error instanceof AggregateError && assert.deepEqual(error.errors, errors) === undefined,
        );
        assert.equal(app.dispose(), disposal);
        assert.deepEqual(app.getEndpoints(), []);
    });

    it("retains both pairing and sensing-mode restoration failures", async () => {
        const { connection, frame } = customConnection();
        const app = createHaritoraX({ connections: [connection], logLevel: "silent" });
        await app.discover();
        await app.connect("COM3");
        frame("o:3040");
        const failures = [new Error("pair command"), new Error("restore command")];
        let attempts = 0;
        connection.write = () => Promise.reject(failures[attempts++]);
        await assert.rejects(app.pair("COM3", "0"), (error: unknown) => {
            assert.ok(error instanceof AggregateError);
            assert.deepEqual(error.errors, failures);
            return true;
        });
        await app.dispose();
    });

    it("reports rejected log callbacks and other event callbacks", async () => {
        const { connection } = customConnection();
        const app = createHaritoraX({
            connections: [connection],
            logLevel: "info",
            onLog: () => Promise.reject(new Error("sink")),
        });
        const reports: HaritoraXErrorEvent[] = [];
        app.on("error", (event) => reports.push(event));
        app.on("endpoint:connected", () => {
            throw new Error("connected listener");
        });
        await app.discover();
        await app.connect("COM3");
        await setImmediate();
        assert.ok(reports.some(({ error }) => error.message === "sink"));
        assert.ok(reports.some(({ operation }) => operation === "listener:endpoint:connected"));
        await app.dispose();
    });
});

describe("serial background failures", () => {
    it("reports startup and heartbeat failures through the interpreter at silent logging", async () => {
        const port = new Port();
        const error = new Error("native write denied");
        port.failure = error;
        const connection = serial(port, 5);
        const app = createHaritoraX({ connections: [connection], logLevel: "silent" });
        const reports: HaritoraXErrorEvent[] = [];
        app.on("error", (event) => reports.push(event));
        await app.discover();
        await app.connect("COM3");
        await delay(15);
        assert.ok(reports.some(({ operation }) => operation === "startup"));
        assert.ok(reports.some(({ operation }) => operation === "heartbeat"));
        assert.ok(reports.every(({ error: failure }) => failure.cause === error));
        await app.dispose();
        const count = reports.length;
        port.emit("error", error);
        await delay(10);
        assert.equal(reports.length, count);
    });

    it("reports unsolicited stream errors, isolates subscribers, and keeps external listeners", async () => {
        const port = new Port();
        let external = 0;
        port.on("data", () => external++);
        const connection = serial(port);
        connection.onError(() => {
            throw new Error("subscriber");
        });
        connection.onError(() => Promise.reject(new Error("async subscriber")));
        const reports: ConnectionErrorEvent[] = [];
        connection.onError((event) => reports.push(event));
        await connection.open("COM3");
        const failure = new Error("stream");
        port.emit("error", failure);
        assert.equal(reports[0]?.error, failure);
        assert.equal(reports[0]?.operation, "stream");
        await connection.close("COM3");
        port.emit("error", failure);
        port.emit("data", new Uint8Array());
        await setImmediate();
        assert.equal(reports.length, 1);
        assert.equal(external, 1);
        await connection.dispose();
    });

    it("rejects explicit writes and close failures without duplicating them as background reports", async () => {
        const port = new Port();
        const connection = serial(port);
        const reports: ConnectionErrorEvent[] = [];
        connection.onError((event) => reports.push(event));
        await connection.open("COM3");
        port.failure = new Error("write");
        await assert.rejects(
            connection.write("COM3", new Uint8Array()),
            (error: unknown) => error instanceof HaritoraXError && error.cause === port.failure,
        );
        port.closeFailure = new Error("close");
        await assert.rejects(
            connection.close("COM3"),
            (error: unknown) => error instanceof HaritoraXError && error.cause === port.closeFailure,
        );
        assert.deepEqual(reports, []);
        await connection.dispose();
    });

    it("reports delayed startup failures and cancels the remaining timer work on close", async () => {
        mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
        const port = new Port();
        const connection = serial(port);
        const reports: ConnectionErrorEvent[] = [];
        connection.onError((event) => reports.push(event));
        try {
            await connection.open("COM3");
            port.failure = new Error("delayed write");
            mock.timers.tick(1_500);
            await setImmediate();
            assert.equal(reports.length, 7);
            assert.ok(reports.every(({ operation, error }) => operation === "startup" && error.cause === port.failure));
            await connection.close("COM3");
            mock.timers.tick(10_000);
            await setImmediate();
            assert.equal(reports.length, 7);
        } finally {
            await connection.dispose();
            mock.timers.reset();
        }
    });

    it("keeps caller cancellation quiet for a manually configured serial probe", async () => {
        const controller = new AbortController();
        const connection = new SerialConnection(
            {
                list: () => Promise.resolve([]),
                open: () => new Promise<SerialPort>(() => {}),
            },
            { serialPorts: ["COM3"], operationTimeoutMs: 100 },
        );
        const reports: ConnectionErrorEvent[] = [];
        connection.onError((event) => reports.push(event));
        const listing = connection.list({ signal: controller.signal });
        await setImmediate();
        controller.abort();
        await listing;
        assert.deepEqual(reports, []);
        await connection.dispose();
    });

    it("guards errors after probing and a late open without removing unrelated listeners", async () => {
        const port = new Port();
        let finishOpen!: (port: SerialPort) => void;
        const connection = new SerialConnection(
            {
                list: () => Promise.resolve([]),
                open: () =>
                    new Promise((resolve) => {
                        finishOpen = resolve;
                    }),
            },
            {
                serialPorts: ["COM3"],
                operationTimeoutMs: 5,
                heartbeatIntervalMs: 0,
            },
        );
        const reports: ConnectionErrorEvent[] = [];
        connection.onError((event) => reports.push(event));
        await connection.list();
        assert.ok(
            reports.some(({ operation }) => operation === "probe"),
            "an active deadline is observable",
        );
        finishOpen(port);
        await setImmediate();
        assert.equal(port.isOpen, false);
        assert.doesNotThrow(() => port.emit("error", new Error("late")));
        await connection.dispose();
    });
});

class Gatt extends EventEmitter {
    properties = ["read", "notify", "write"];
    readFailure: Error | undefined;
    subscribeFailure: Error | undefined;
    readonly uuid: string;
    readonly value: Uint8Array;
    constructor(uuid: string, value: Uint8Array) {
        super();
        this.uuid = uuid;
        this.value = value;
    }
    readAsync(): Promise<Uint8Array> {
        return this.readFailure ? Promise.reject(this.readFailure) : Promise.resolve(this.value);
    }
    subscribeAsync(): Promise<void> {
        return this.subscribeFailure ? Promise.reject(this.subscribeFailure) : Promise.resolve();
    }
    writeAsync(): Promise<void> {
        return Promise.resolve();
    }
}
class Peripheral extends EventEmitter {
    id = "ble-1";
    state = "connected";
    advertisement = { localName: "HaritoraX2-ABC123", serviceUuids: [] };
    rssi = -50;
    connectable = true;
    characteristics = [
        new Gatt("2a25", new TextEncoder().encode("ABC123")),
        new Gatt("2a24", new TextEncoder().encode("MC4B")),
        new Gatt("00dbf1c690aa11eda1eb0242ac120002", new Uint8Array(14)),
        new Gatt("2a19", new Uint8Array([80])),
    ];
    disconnectFailure: Error | undefined;
    discoverAllServicesAndCharacteristicsAsync() {
        return Promise.resolve({ services: [], characteristics: this.characteristics });
    }
    disconnectAsync(): Promise<void> {
        return this.disconnectFailure ? Promise.reject(this.disconnectFailure) : Promise.resolve();
    }
    updateRssiAsync(): Promise<number> {
        return Promise.resolve(-50);
    }
}
class Noble extends EventEmitter {
    state = "poweredOn";
    peripheral = new Peripheral();
    waitForPoweredOnAsync = () => Promise.resolve();
    startScanningAsync = () => {
        this.emit("discover", this.peripheral);
        return Promise.resolve();
    };
    stopScanningAsync = () => Promise.resolve();
    stop() {}
}
function ble(noble: Noble, rssiPollMs = 0) {
    const require = createRequire(import.meta.url);
    const id = require.resolve("@stoprocent/noble");
    const previous = require.cache[id];
    require.cache[id] = { exports: { withBindings: () => noble } } as NodeJS.Module;
    try {
        return createBleConnection({ binding: "hci", operationTimeoutMs: 20, scanTimeoutMs: 1, rssiPollMs });
    } finally {
        if (previous) require.cache[id] = previous;
        else delete require.cache[id];
    }
}

describe("BLE native error propagation", () => {
    it("forwards native adapter and peripheral errors and releases owned listeners", async () => {
        const native = new Noble();
        const connection = ble(native);
        const reports: ConnectionErrorEvent[] = [];
        connection.onError((event) => reports.push(event));
        const failure = new Error("binding");
        native.emit("error", failure);
        assert.equal(reports[0]?.error.cause, failure);
        assert.equal(reports[0]?.operation, "adapter");
        await connection.list();
        await connection.open("ble-1");
        native.peripheral.emit("error", failure);
        assert.equal(reports.at(-1)?.endpointId, "ble-1");
        native.peripheral.characteristics[2]!.emit("error", failure);
        assert.equal(reports.at(-1)?.characteristic, "sensor");
        native.state = "unauthorized";
        native.emit("stateChange", native.state);
        assert.equal(reports.at(-1)?.adapterState, "unauthorized");
        await connection.dispose();
        assert.equal(native.listenerCount("stateChange"), 0);
        assert.equal(native.peripheral.listenerCount("disconnect"), 0);
        const count = reports.length;
        native.emit("error", failure);
        native.peripheral.emit("error", failure);
        assert.equal(reports.length, count);
    });

    it("rejects an active scan for a binding error with cause and adapter state", async () => {
        const native = new Noble();
        native.waitForPoweredOnAsync = () => new Promise(() => {});
        const connection = ble(native);
        const reports: ConnectionErrorEvent[] = [];
        connection.onError((event) => reports.push(event));
        const failure = new Error("dbus unavailable");
        const listing = connection.list();
        native.emit("error", failure);
        await assert.rejects(
            listing,
            (error: unknown) =>
                error instanceof HaritoraXError &&
                error.context.adapterState === "poweredOn" &&
                (error.cause as Error).cause === failure,
        );
        assert.deepEqual(reports, []);
        await connection.dispose();
    });

    it("cleans up cancellation while starting a native scan", async () => {
        const native = new Noble();
        native.startScanningAsync = () => new Promise<void>(() => {});
        const connection = ble(native);
        const reports: ConnectionErrorEvent[] = [];
        connection.onError((event) => reports.push(event));
        const controller = new AbortController();
        const listing = connection.list({ signal: controller.signal, timeoutMs: 100 });
        await setImmediate();
        controller.abort();
        assert.deepEqual(await listing, []);
        assert.equal(native.listenerCount("discover"), 0);
        assert.deepEqual(reports, []);
        await connection.dispose();
    });

    it("preserves required identity read errors and characteristic context", async () => {
        const native = new Noble();
        const failure = new Error("GATT denied");
        native.peripheral.characteristics[0]!.readFailure = failure;
        const connection = ble(native);
        await connection.list();
        await assert.rejects(connection.open("ble-1"), (error: unknown) => {
            assert.ok(error instanceof HaritoraXError);
            const cause = error.cause as HaritoraXError;
            assert.equal(cause.cause, failure);
            assert.equal(cause.context.characteristic, "serial-number");
            return true;
        });
        await connection.dispose();
    });

    it("preserves failed sensor subscriptions as causes of startup failure", async () => {
        const native = new Noble();
        const failure = new Error("subscribe denied");
        native.peripheral.characteristics[2]!.subscribeFailure = failure;
        const connection = ble(native);
        const reports: ConnectionErrorEvent[] = [];
        connection.onError((event) => reports.push(event));
        await connection.list();
        await assert.rejects(connection.open("ble-1"), (error: unknown) => {
            assert.ok(error instanceof HaritoraXError);
            const cause = error.cause as HaritoraXError;
            const aggregate = cause.cause as AggregateError;
            assert.equal(aggregate.errors[0].cause, failure);
            assert.equal(aggregate.errors[0].context.characteristic, "sensor");
            return true;
        });
        assert.deepEqual(reports, []);
        await connection.dispose();
    });

    it("reports optional read failures and rejects explicit read failures", async () => {
        const native = new Noble();
        const failure = new Error("read denied");
        native.peripheral.characteristics[3]!.readFailure = failure;
        const connection = ble(native);
        const reports: ConnectionErrorEvent[] = [];
        connection.onError((event) => reports.push(event));
        await connection.list();
        await connection.open("ble-1");
        assert.equal(reports[0]?.error.cause, failure);
        assert.equal(reports[0]?.characteristic, "battery-level");
        await assert.rejects(
            connection.read("ble-1", "battery-level"),
            (error: unknown) => error instanceof HaritoraXError && error.cause === failure,
        );
        assert.equal(reports.length, 1);
        await connection.dispose();
    });

    it("rejects partial refresh failures with all native causes", async () => {
        const native = new Noble();
        const connection = ble(native);
        const app = createHaritoraX({ connections: [connection], logLevel: "silent" });
        await app.discover();
        await app.connect("ble-1");
        const failure = new Error("battery inaccessible");
        native.peripheral.characteristics[3]!.readFailure = failure;
        await assert.rejects(app.refreshTracker("ABC123:0"), (error: unknown) => {
            assert.ok(error instanceof HaritoraXError);
            assert.equal(error.code, "READ_FAILED");
            assert.equal((error.cause as AggregateError).errors[0].cause.cause, failure);
            return true;
        });
        await app.dispose();
    });

    it("contains synchronous native failures during background RSSI polling", async () => {
        const native = new Noble();
        const failure = new Error("synchronous RSSI failure");
        native.peripheral.updateRssiAsync = () => {
            throw failure;
        };
        const connection = ble(native, 1_000);
        const reports: ConnectionErrorEvent[] = [];
        connection.onError((event) => reports.push(event));
        await connection.list();
        await connection.open("ble-1");
        await setImmediate();
        assert.ok(reports.some(({ operation, error }) => operation === "rssi" && error === failure));
        await connection.dispose();
    });

    it("rejects native disconnect failures through public close", async () => {
        const native = new Noble();
        const connection = ble(native);
        await connection.list();
        await connection.open("ble-1");
        const failure = new Error("disconnect");
        native.peripheral.disconnectFailure = failure;
        await assert.rejects(connection.close("ble-1"), (error: unknown) => error === failure);
        await connection.dispose();
    });
});
