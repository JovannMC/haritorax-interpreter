import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSerialConnection } from "../dist/connections/serial/serial-node.js";
import type { PortSummary, SerialBackend, SerialPort } from "../dist/connections/serial/serial-node.js";
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

// `portReplies` lets a wired probe see a device: when the first write (the knock) is
// made to a path that has a configured reply, the reply is emitted asynchronously so the
// probe's data listener (registered right after open) has been attached already.
function backendWith(ports: PortSummary[], port?: FakePort, portReplies?: ReadonlyMap<string, string>): SerialBackend {
    return {
        list: () => Promise.resolve(ports),
        open: (path) => {
            if (!port) return Promise.reject(new Error("no port"));
            const reply = portReplies?.get(path);
            if (!reply) return Promise.resolve(port);

            let replied = false;
            const proxied: SerialPort = {
                get isOpen(): boolean {
                    return port.isOpen;
                },
                on(event, listener): void {
                    if (event === "data") port.on("data", listener);
                    else if (event === "close") port.on("close", listener);
                    else port.on("error", listener);
                },
                write: (data, callback) => {
                    if (!replied) {
                        replied = true;
                        queueMicrotask(() => port.receiveText(reply));
                    }
                    port.write(data, callback);
                },
                close: (callback) => port.close(callback),
                removeAllListeners: () => port.removeAllListeners(),
            };
            return Promise.resolve(proxied);
        },
    };
}

function asciiEncode(text: string): Uint8Array {
    const bytes = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
    return bytes;
}

const WIRED_INFO_REPLY = 'i:{"model":"MC2", "version":"1.7.8", "serial no":"1111111", "comm":"BLT", "comm_next":"BTSPP"}\n';

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

    it("lists wired SPP ports when includeWired is enabled", async () => {
        const ports: PortSummary[] = [
            { path: "/dev/rfcomm0" },
            { path: "COM7", manufacturer: "HaritoraX" },
            { path: "COM8", manufacturer: "Other" },
            { path: "COM9", serialNumber: "HaritoraX-0506200" },
        ];

        // Each wired candidate answers the probe's knock with a valid info packet.
        const port = new FakePort();
        const replies = new Map([
            ["/dev/rfcomm0", WIRED_INFO_REPLY],
            ["COM7", WIRED_INFO_REPLY],
            ["COM9", WIRED_INFO_REPLY],
        ]);

        const without = createSerialConnection({ backend: backendWith(ports, port, replies) });
        assert.deepEqual(
            (await without.list()).map((descriptor) => descriptor.id),
            [],
        );

        const withWired = createSerialConnection({ backend: backendWith(ports, port, replies), includeWired: true });
        const found = await withWired.list();

        assert.deepEqual(
            found.map((descriptor) => [descriptor.id, descriptor.model]),
            [
                ["/dev/rfcomm0", "wired"],
                ["COM7", "wired"],
                ["COM9", "wired"],
            ],
        );
    });

    it("probes manually configured serial ports even when enumeration omits them", async () => {
        const port = new FakePort();
        const connection = createSerialConnection({
            backend: backendWith([], port, new Map([["COM14", WIRED_INFO_REPLY]])),
            serialPorts: ["COM14"],
        });

        const found = await connection.list();

        assert.deepEqual(
            found.map((descriptor) => [descriptor.id, descriptor.model]),
            [["COM14", "wired"]],
        );
    });

    it("keeps manually configured non-wired serial ports as generic endpoints", async () => {
        const port = new FakePort();
        const connection = createSerialConnection({
            backend: backendWith(
                [],
                port,
                new Map([["COM6", 'i:{"model":"MC4B", "version":"1.0", "serial no":"GX6MAN"}\n']]),
            ),
            serialPorts: ["COM6"],
        });

        const found = await connection.list();

        assert.deepEqual(found.map((descriptor) => [descriptor.id, descriptor.model]), [["COM6", undefined]]);
    });

    it("lists Windows BTHENUM SPP ports by their Serial Port Profile GUID", async () => {
        // Shaped after a real Get-PnpDevice dump: the wired HaritoraX port has no
        // name, no VID/PID and a generic "Microsoft" manufacturer; only the SPP
        // service-class GUID in the pnpId identifies it as a candidate, and the probe
        // confirms it with a real info reply.
        const ports: PortSummary[] = [
            {
                path: "COM5",
                vendorId: "04DA",
                productId: "3F18",
                pnpId: "USB\\VID_04DA&PID_3F18\\C0C0118A0C8D",
            },
            {
                path: "COM3",
                vendorId: "1A86",
                productId: "5523",
                pnpId: "USB\\VID_1A86&PID_5523\\6&1DF6E647&0&1",
            },
            // The wired HaritoraX port: no name, no VID/PID, generic manufacturer.
            {
                path: "COM14",
                manufacturer: "Microsoft",
                pnpId:
                    "BTHENUM\\{00001101-0000-1000-8000-00805F9B34FB}_LOCALMFG&001D\\A&3A86B8C9&0&EC64C9445182_C00000000",
            },
            // A paired BTHENUM device advertising a different RFCOMM service class
            // (dial-up modem) must not even be probed — the GUID filter rejects it.
            {
                path: "COM13",
                manufacturer: "Microsoft",
                pnpId: "BTHENUM\\{00001103-0000-1000-8000-00805F9B34FB}_LOCALMFG&0000\\A&3A86B8C9&0&000000000000_00000008",
            },
            // Same SPP GUID as the tracker but answers with a wireless model —
            // probed, then rejected by the model check.
            {
                path: "COM15",
                manufacturer: "Microsoft",
                pnpId:
                    "BTHENUM\\{00001101-0000-1000-8000-00805F9B34FB}_LOCALMFG&0020\\A&3A86B8C9&0&111111111111_000000000",
            },
            // Same SPP GUID but silent (no reply) — probed, then rejected by timeout.
            {
                path: "COM16",
                manufacturer: "Microsoft",
                pnpId:
                    "BTHENUM\\{00001101-0000-1000-8000-00805F9B34FB}_LOCALMFG&0021\\A&3A86B8C9&0&222222222222_000000000",
            },
        ];

        const port = new FakePort();
        const replies = new Map([
            ["COM14", WIRED_INFO_REPLY],
            // A paired wireless tracker on SPP would report a non-wired model.
            ["COM15", 'i:{"model":"MC3S", "version":"1.7.8", "serial no":"ABCD123"}\n'],
        ]);

        const without = createSerialConnection({ backend: backendWith(ports, port, replies) });
        // Without includeWired only the GX6 dongle port is listed.
        assert.deepEqual(
            (await without.list()).map((descriptor) => [descriptor.id, descriptor.dongle]),
            [["COM5", "GX6"]],
        );

        const withWired = createSerialConnection({ backend: backendWith(ports, port, replies), includeWired: true });
        const found = await withWired.list();

        assert.deepEqual(
            found.map((descriptor) => [descriptor.id, descriptor.model, descriptor.dongle]),
            [
                ["COM5", undefined, "GX6"],
                ["COM14", "wired", undefined],
            ],
        );
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

    it("uses the wired heartbeat for wired endpoints", async () => {
        const port = new FakePort();
        const connection = createSerialConnection({
            backend: backendWith([{ path: "/dev/rfcomm0" }], port, new Map([["/dev/rfcomm0", WIRED_INFO_REPLY]])),
            includeWired: true,
            heartbeatIntervalMs: 20,
        });

        const found = await connection.list();
        assert.equal(found[0]?.model, "wired");

        await connection.open("/dev/rfcomm0");
        await new Promise((resolve) => setTimeout(resolve, 70));
        assert.ok(port.written.filter((line) => line === "\nreport send info\nblt send info\n").length >= 2);

        await connection.close("/dev/rfcomm0");
    });
});

function asciiDecode(bytes: Uint8Array): string {
    let text = "";
    for (const byte of bytes) text += String.fromCharCode(byte);
    return text;
}
