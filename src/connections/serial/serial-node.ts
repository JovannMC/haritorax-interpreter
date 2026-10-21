import { autoDetect } from "@serialport/bindings-cpp";
import { SerialPortStream } from "@serialport/stream";
import { SerialConnection } from "./index.js";
import type { SerialBackend, SerialOptions } from "./index.js";
import type { Connection } from "../contract.js";

// from haritora_setting.json in HaritoraConfigurator
const BAUD_RATE = 500_000;

export interface NodeSerialOptions extends SerialOptions {
    backend?: SerialBackend;
}

export function createSerialConnection(options: NodeSerialOptions = {}): Connection {
    return new SerialConnection(options.backend ?? createNodeBackend(), options);
}

function createNodeBackend(): SerialBackend {
    const binding = autoDetect();

    return {
        list: () => binding.list(),
        open: (path) => Promise.resolve(new SerialPortStream({ path, baudRate: BAUD_RATE, binding })),
    };
}

export type { PortSummary, SerialBackend, SerialOptions, SerialPort } from "./index.js";
