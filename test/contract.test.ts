import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHaritoraX } from "../dist/index.js";
import type { Connection, Frame, ListOptions } from "../dist/connections/contract.js";
import type { DeviceDescriptor, DisconnectReason, Unsubscribe } from "../dist/types.js";

/** In-memory connection: the reference implementation of the contract. */
function memoryConnection(endpoints: string[] = ["COM4"]) {
    const dataHandlers = new Set<(frame: Frame) => void>();
    const lostHandlers = new Set<(endpointId: string, reason: DisconnectReason) => void>();
    const opened = new Set<string>();

    const connection = {
        kind: "serial" as const,
        opened,

        list(_options?: ListOptions): Promise<DeviceDescriptor[]> {
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
        app.on("device:connected", ({ deviceId }) => connected.push(deviceId));

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

        const disconnects: Array<{ deviceId: string; reason: string }> = [];
        app.on("device:disconnected", (event) => disconnects.push(event));

        await app.discover();
        await app.connect("COM4");
        await app.disconnect("COM4");

        assert.deepEqual(disconnects, [{ deviceId: "COM4", reason: "requested" }]);
        assert.equal(serial.opened.size, 0);
    });

    it("surfaces a connection loss as device:disconnected", async () => {
        const serial = memoryConnection(["COM4"]);
        const app = createHaritoraX({ connections: [serial], logLevel: "silent" });

        const disconnects: Array<{ deviceId: string; reason: string }> = [];
        app.on("device:disconnected", (event) => disconnects.push(event));

        await app.discover();
        await app.connect("COM4");
        serial.emitLost("COM4", "remote");

        assert.deepEqual(disconnects, [{ deviceId: "COM4", reason: "remote" }]);
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
