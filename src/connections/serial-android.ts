import { HaritoraXError } from "../errors.js";
import { SerialConnection } from "./serial.js";
import type { SerialBackend, SerialOptions } from "./serial.js";
import type { Connection } from "./contract.js";

const unavailable = (): Promise<never> =>
    Promise.reject(new HaritoraXError("LINK_UNAVAILABLE", "Android USB serial is not implemented yet"));

const androidSerialBackend: SerialBackend = Object.freeze({
    list: unavailable,
    open: unavailable,
});

export function createSerialConnection(options: SerialOptions = {}): Connection {
    return new SerialConnection(androidSerialBackend, options);
}

export type { PortSummary, SerialBackend, SerialOptions, SerialPort } from "./serial.js";
