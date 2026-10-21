import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSerialConnection } from "../dist/connections/serial-node.js";
import type { PortSummary, SerialBackend, SerialPort } from "../dist/connections/serial-node.js";
import type { Frame } from "../dist/connections/contract.js";
import type { DisconnectReason } from "../dist/types.js";

/** A fake serialport stream that lets the test push bytes and observe writes. */
class FakePort implements SerialPort {
    readonly written: string[] = [];
    isOpen = true;

    #data: Array<(chunk: Uint8Array) => void> = [];
    #close: Array<() => void> = [];
    #error: Array<(error: Error) => void> = [];

    on(event: "data" | "close" | "error", listener: (arg: never) => void): void {
        if (event === "data") this.#data.push(listener as (chunk: Uint8Array) => void);
        else if (event === "close") this.#close.push(listener as () => void);
        else this.#error.push(listener as (error: Error) => void);
    }

    write(data: string, callback: (error?: Error | null) => void): void {
        this.written.push(data);
        callback(null);
    }

    close(callback?: (error?: Error | null) => void): void {
        this.isOpen = false;
        callback?.(null);
    }

    removeAllListeners(): void {
        this.#data = [];
        this.#close = [];
        this.#error = [];
    }

    /** Test helpers. */
    receive(bytes: Uint8Array): void {
        for (const listener of this.#data) listener(bytes);
    }

    receiveText(text: string): void {
        this.receive(asciiEncode(text));
    }

    emitClose(): void {
        for (const listener of this.#close) listener();
    }
}

function backendWith(ports: PortSummary[], port?: SerialPort): SerialBackend {
    return {
        list: () => Promise.resolve(ports),
        open: () => (port ? Promise.resolve(port) : Promise.reject(new Error("no port"))),
    };
}

function asciiEncode(text: string): Uint8Array {
    const bytes = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
    return bytes;
}

describe("serial connection", () => {
    it("lists only known dongle ports by VID/PID", async () => {
        const connection = createSerialConnection({
            backend: backendWith([
                { path: "COM3", vendorId: "04DA", productId: "3F18" },
                { path: "COM4", vendorId: "1915", productId: "520F" },
                { path: "COM5", vendorId: "1234", productId: "5678" },
                { path: "/dev/ttyUSB0" },
            ]),
        });

        const found = await connection.list();

        assert.deepEqual(
            found.map((descriptor) => [descriptor.id, descriptor.dongle]),
            [
                ["COM3", "GX6"],
                ["COM4", "GX2"],
            ],
        );
        assert.equal(found[0]?.connection, "serial");
        assert.equal(found[0]?.displayName, "GX6 (COM3)");
    });

    it("honours an already-aborted signal", async () => {
        const controller = new AbortController();
        controller.abort();

        let listed = false;
        const connection = createSerialConnection({
            backend: {
                list: () => {
                    listed = true;
                    return Promise.resolve([]);
                },
                open: () => Promise.reject(new Error("unexpected")),
            },
        });

        assert.deepEqual(await connection.list({ signal: controller.signal }), []);
        assert.equal(listed, false);
    });

    it("emits one frame per complete line and holds partial lines", async () => {
        const port = new FakePort();
        const connection = createSerialConnection({
            backend: backendWith([], port),
            heartbeatIntervalMs: 0,
        });

        const frames: Frame[] = [];
        connection.onData((frame) => frames.push(frame));
        await connection.open("COM3");

        // Two complete lines and half of a third in one chunk.
        port.receive(asciiEncode('i:{"model":"GX2"}\r\nX0:QQV1\r\nX1:PP'));

        assert.deepEqual(
            frames.map((frame) => asciiDecode(frame.data)),
            ['i:{"model":"GX2"}', "X0:QQV1"],
        );

        // The remainder completes on the next chunk.
        port.receive(asciiEncode("+sAf\r\n"));
        assert.equal(frames.length, 3);
        assert.equal(asciiDecode(frames[2]!.data), "X1:PP+sAf");
        assert.equal(frames[0]?.endpointId, "COM3");

        await connection.close("COM3");
    });

    it("sends the v3 open commands wrapped in newlines", async () => {
        const port = new FakePort();
        const connection = createSerialConnection({
            backend: backendWith([], port),
            heartbeatIntervalMs: 0,
        });

        await connection.open("COM3");
        await connection.close("COM3");

        // The dongle needs both newlines around every command.
        assert.deepEqual(port.written.slice(0, 4), ["\nr0:\n", "\nr1:\n", "\nr:\n", "\no:\n"]);
    });

    it("reports loss once when an unexpected close happens", async () => {
        const port = new FakePort();
        const connection = createSerialConnection({
            backend: backendWith([], port),
            heartbeatIntervalMs: 0,
        });

        const lost: Array<[string, DisconnectReason]> = [];
        connection.onLost((endpointId, reason) => lost.push([endpointId, reason]));

        await connection.open("COM3");
        port.emitClose();

        assert.deepEqual(lost, [["COM3", "remote"]]);
    });

    it("does not report loss for an intentional close", async () => {
        const port = new FakePort();
        const connection = createSerialConnection({
            backend: backendWith([], port),
            heartbeatIntervalMs: 0,
        });

        const lost: string[] = [];
        connection.onLost((endpointId) => lost.push(endpointId));

        await connection.open("COM3");
        await connection.close("COM3");
        port.emitClose();

        assert.deepEqual(lost, []);
        assert.equal(port.isOpen, false);
    });

    it("is idempotent for open, close and dispose", async () => {
        const port = new FakePort();
        let opened = 0;

        const connection = createSerialConnection({
            backend: {
                list: () => Promise.resolve([]),
                open: () => {
                    opened++;
                    return Promise.resolve(port);
                },
            },
            heartbeatIntervalMs: 0,
        });

        await connection.open("COM3");
        await connection.open("COM3");
        assert.equal(opened, 1);

        await connection.close("COM3");
        await connection.close("COM3");
        await connection.dispose();
        await connection.dispose();
    });

    it("rejects writes to an unopened endpoint with DEVICE_NOT_FOUND", async () => {
        const connection = createSerialConnection({
            backend: backendWith([]),
            heartbeatIntervalMs: 0,
        });

        const error = await connection.write("COM9", new Uint8Array([0x69])).catch((err: unknown) => err);
        assert.equal((error as { code?: string }).code, "DEVICE_NOT_FOUND");
    });

    it("reports LINK_UNAVAILABLE when the binding cannot load", async () => {
        const connection = createSerialConnection({
            backend: {
                list: () => Promise.reject(new Error("no native binding")),
                open: () => Promise.reject(new Error("unexpected")),
            },
        });

        const error = await connection.list().catch((err: unknown) => err);
        assert.equal((error as { code?: string }).code, "LINK_UNAVAILABLE");
    });

    it("keeps the heartbeat alive until close", async () => {
        const port = new FakePort();
        const connection = createSerialConnection({
            backend: backendWith([], port),
            heartbeatIntervalMs: 20,
        });

        await connection.open("COM3");
        await new Promise((resolve) => setTimeout(resolve, 70));
        assert.ok(port.written.filter((line) => line === "\ni:\n").length >= 2);

        await connection.close("COM3");
        const afterClose = port.written.length;
        await new Promise((resolve) => setTimeout(resolve, 60));

        // The interval must not survive close; v3 leaked exactly this.
        assert.equal(port.written.length, afterClose);
    });
});

function asciiDecode(bytes: Uint8Array): string {
    let text = "";
    for (const byte of bytes) text += String.fromCharCode(byte);
    return text;
}
