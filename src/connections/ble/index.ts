import { HaritoraXError } from "../../lib/errors.js";
import type { Logger } from "../../lib/logging.js";
import { parseBleDeviceName, type BleCharacteristic } from "../../protocol/ble.js";
import type { Connection, Frame, ListOptions, WriteOptions } from "../contract.js";
import type { DisconnectReason, EndpointDescriptor, Unsubscribe } from "../../types.js";

export interface BlePeripheralSummary {
    id: string;
    localName?: string;
    rssi?: number;
}

export type BleDataHandler = (peripheralId: string, characteristic: BleCharacteristic, data: Uint8Array) => void;

export interface BleBackend {
    scan(options?: ListOptions): Promise<BlePeripheralSummary[]>;
    open(peripheralId: string): Promise<void>;
    close(peripheralId: string): Promise<void>;
    read(peripheralId: string, characteristic: BleCharacteristic): Promise<Uint8Array | undefined>;
    write(peripheralId: string, characteristic: BleCharacteristic, data: Uint8Array): Promise<void>;
    onData(handler: BleDataHandler): Unsubscribe;
    onLost(handler: (peripheralId: string, reason: DisconnectReason) => void): Unsubscribe;
    dispose(): Promise<void>;
}

export interface BleConnectionOptions {
    scanTimeoutMs?: number;
    logger?: Logger;
}

const DEFAULT_SCAN_TIMEOUT_MS = 5_000;

export class BleConnection implements Connection {
    readonly kind = "ble" as const;

    readonly #backend: BleBackend;
    readonly #scanTimeoutMs: number;
    readonly #log: Logger | undefined;

    readonly #open = new Set<string>();
    readonly #dataHandlers = new Set<(frame: Frame) => void>();
    readonly #lostHandlers = new Set<(endpointId: string, reason: DisconnectReason) => void>();
    readonly #subscriptions: Unsubscribe[] = [];

    constructor(backend: BleBackend, options: BleConnectionOptions = {}) {
        this.#backend = backend;
        this.#scanTimeoutMs = options.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS;
        this.#log = options.logger;

        this.#subscriptions.push(
            backend.onData((peripheralId, characteristic, data) => {
                const frame: Frame = { endpointId: peripheralId, characteristic, data };
                for (const handler of [...this.#dataHandlers]) handler(frame);
            }),
            backend.onLost((peripheralId, reason) => {
                this.#open.delete(peripheralId);
                for (const handler of [...this.#lostHandlers]) handler(peripheralId, reason);
            }),
        );
    }

    async list(options?: ListOptions): Promise<EndpointDescriptor[]> {
        const peripherals = await this.#backend.scan({ ...options, timeoutMs: options?.timeoutMs ?? this.#scanTimeoutMs });

        return peripherals.flatMap((peripheral): EndpointDescriptor[] => {
            const device = parseBleDeviceName(peripheral.localName);
            if (!device) return [];

            return [
                {
                    id: peripheral.id,
                    connection: this.kind,
                    displayName: device.localName,
                    model: device.model,
                    ...(peripheral.rssi === undefined ? {} : { rssi: peripheral.rssi }),
                },
            ];
        });
    }

    async open(endpointId: string): Promise<void> {
        if (this.#open.has(endpointId)) return;

        await this.#backend.open(endpointId);
        this.#open.add(endpointId);
    }

    async close(endpointId: string): Promise<void> {
        if (!this.#open.delete(endpointId)) return;

        await this.#backend.close(endpointId);
    }

    async write(endpointId: string, data: Uint8Array, options?: WriteOptions): Promise<void> {
        if (!this.#open.has(endpointId)) {
            throw new HaritoraXError("DEVICE_NOT_FOUND", `${endpointId} is not open`);
        }

        const characteristic = options?.characteristic;
        if (!characteristic) {
            throw new HaritoraXError("NOT_SUPPORTED", "BLE writes require a characteristic");
        }

        await this.#backend.write(endpointId, characteristic as BleCharacteristic, data);
    }

    onData(handler: (frame: Frame) => void): Unsubscribe {
        this.#dataHandlers.add(handler);
        return () => this.#dataHandlers.delete(handler);
    }

    onLost(handler: (endpointId: string, reason: DisconnectReason) => void): Unsubscribe {
        this.#lostHandlers.add(handler);
        return () => this.#lostHandlers.delete(handler);
    }

    async dispose(): Promise<void> {
        for (const unsubscribe of this.#subscriptions) unsubscribe();
        this.#subscriptions.length = 0;

        this.#dataHandlers.clear();
        this.#lostHandlers.clear();

        await this.#backend.dispose().catch((error: unknown) => {
            this.#log?.error("Failed to dispose the BLE backend", { error: String(error) });
        });
        this.#open.clear();
    }
}
