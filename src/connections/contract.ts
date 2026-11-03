import type { ConnectionKind, EndpointDescriptor, DisconnectReason, Unsubscribe } from "../types.js";

export interface Frame {
    // the endpoint the bytes came from - a BLE local name or a serial path
    endpointId: string;
    data: Uint8Array;
    characteristic?: string;
}

export interface ListOptions {
    // return results after this time
    timeoutMs?: number;
    // stop scanning once this known BLE endpoint is found
    targetEndpointId?: string;
    // return no results if the signal is aborted before the timeout expires.
    signal?: AbortSignal;
}

export interface WriteOptions {
    // BLE only, which characteristic to write to
    characteristic?: string;
}

export interface Connection {
    readonly kind: ConnectionKind;

    // what this connection can see (connected or not) - BLE peripherals or serial ports
    list(options?: ListOptions): Promise<EndpointDescriptor[]>;

    open(endpointId: string): Promise<void>;
    close(endpointId: string): Promise<void>;
    write(endpointId: string, data: Uint8Array, options?: WriteOptions): Promise<void>;
    // BLE only, returns undefined if the characteristic is not found or the read fails
    read?(endpointId: string, characteristic: string): Promise<Uint8Array | undefined>;

    onData(handler: (frame: Frame) => void): Unsubscribe;
    onLost(handler: (endpointId: string, reason: DisconnectReason) => void): Unsubscribe;
    onRssi?(handler: (endpointId: string, rssi: number) => void): Unsubscribe;

    dispose(): Promise<void>;
}
