import type { ConnectionKind, EndpointDescriptor, DisconnectReason, Unsubscribe } from "../types.js";

export interface Frame {
    // the endpoint the bytes came from - a BLE local name or a serial path
    endpointId: string;
    data: Uint8Array;
}

export interface ListOptions {
    timeoutMs?: number;
    signal?: AbortSignal;
}

export interface Connection {
    readonly kind: ConnectionKind;

    // what this connection can see (connected or not) - BLE peripherals or serial ports
    list(options?: ListOptions): Promise<EndpointDescriptor[]>;

    open(endpointId: string): Promise<void>;
    close(endpointId: string): Promise<void>;
    write(endpointId: string, data: Uint8Array): Promise<void>;

    onData(handler: (frame: Frame) => void): Unsubscribe;
    onLost(handler: (endpointId: string, reason: DisconnectReason) => void): Unsubscribe;

    dispose(): Promise<void>;
}
