import { createRequire } from "node:module";
import { HaritoraXError } from "../../lib/errors.js";
import type { Logger } from "../../lib/logging.js";
import { bleCharacteristicFromUuid, type BleCharacteristic } from "../../protocol/endpoint/ble.js";
import { BleConnection, type BleBackend, type BleConnectionOptions, type BlePeripheralSummary } from "./index.js";
import type { ListOptions } from "../contract.js";
import type { DisconnectReason, Unsubscribe } from "../../types.js";
import type { Characteristic, Noble, Peripheral } from "@stoprocent/noble";

// the 2.8.0 type definitions do not include the newer BlueZ D-Bus binding yet
type NobleBinding = "default" | "hci" | "dbus" | "mac" | "win";

interface NobleModule {
    withBindings(binding: NobleBinding, options?: Record<string, unknown>): Noble;
}

export interface NobleBleOptions extends BleConnectionOptions {
    binding?: "auto" | "hci" | "dbus" | "mac" | "win";
}

const INITIAL_READS: readonly BleCharacteristic[] = Object.freeze([
    "serial-number",
    "software-revision",
    "number-of-imu",
    "model-number",
    "body-part",
    "magnetometer",
    "accel-accuracy",
    "sensor-mode",
    "fps",
    "auto-calibration",
    "wired-auto-calibration",
    "tof",
    "battery-level",
    "battery-voltage",
    "charge-status",
]);

export function createBleConnection(options: NobleBleOptions = {}): BleConnection {
    return new BleConnection(createNobleBackend(options), options);
}

class NobleBleBackend implements BleBackend {
    readonly #noble: Noble;
    readonly #log: Logger | undefined;
    readonly #rssiPollMs: number;

    readonly #peripherals = new Map<string, Peripheral>();
    readonly #open = new Map<string, OpenPeripheral>();

    readonly #dataHandlers = new Set<(peripheralId: string, characteristic: BleCharacteristic, data: Uint8Array) => void>();
    readonly #lostHandlers = new Set<(peripheralId: string, reason: DisconnectReason) => void>();
    readonly #rssiHandlers = new Set<(peripheralId: string, rssi: number) => void>();

    readonly #rssiTimers = new Map<string, ReturnType<typeof setInterval>>();

    constructor(noble: Noble, rssiPollMs: number, log: Logger | undefined) {
        this.#noble = noble;
        this.#rssiPollMs = rssiPollMs;
        this.#log = log;
    }

    async scan(options?: ListOptions): Promise<BlePeripheralSummary[]> {
        const found = new Map<string, BlePeripheralSummary>();
        const onDiscover = (peripheral: Peripheral): void => {
            this.#peripherals.set(peripheral.id, peripheral);

            const existing = found.get(peripheral.id);
            const localName = peripheral.advertisement?.localName || existing?.localName;
            const rssi = peripheral.rssi !== 0 ? peripheral.rssi : existing?.rssi;

            found.set(peripheral.id, {
                id: peripheral.id,
                ...(localName ? { localName } : {}),
                ...(rssi === undefined ? {} : { rssi }),
            });
        };

        this.#noble.on("discover", onDiscover);

        try {
            const timeoutMs = options?.timeoutMs ?? 5_000;
            await this.#noble.waitForPoweredOnAsync(timeoutMs);
            if (options?.signal?.aborted) return [];

            await withTimeout(this.#noble.startScanningAsync([], false), timeoutMs, "Timed out starting BLE scan");
            await waitForScanEnd(options?.signal, timeoutMs);
        } finally {
            this.#noble.removeListener("discover", onDiscover);
            await withTimeout(this.#noble.stopScanningAsync(), options?.timeoutMs ?? 5_000, "Timed out stopping BLE scan").catch(
                (error: unknown) => {
                    this.#log?.debug("Failed to stop BLE scanning", { error: String(error) });
                },
            );
        }

        return [...found.values()];
    }

    async open(peripheralId: string): Promise<void> {
        if (this.#open.has(peripheralId)) return;

        const peripheral = this.#peripherals.get(peripheralId);
        if (!peripheral) {
            throw new HaritoraXError("DEVICE_NOT_FOUND", `Unknown BLE peripheral "${peripheralId}", run discover() first`);
        }

        const entry: OpenPeripheral = {
            peripheral,
            characteristics: new Map(),
            subscriptions: [],
            intentional: false,
        };
        entry.onDisconnect = (reason: number | string): void => {
            if (entry.intentional) return;

            this.#log?.warn(`Lost BLE peripheral ${peripheralId}`, { reason: String(reason) });
            this.#open.delete(peripheralId);
            this.#stopRssiPolling(peripheralId);
            for (const handler of [...this.#lostHandlers]) handler(peripheralId, "remote");
        };

        entry.onRssiUpdate = (rssi: number): void => {
            for (const handler of [...this.#rssiHandlers]) handler(peripheralId, rssi);
        };

        this.#open.set(peripheralId, entry);
        peripheral.on("disconnect", entry.onDisconnect);
        peripheral.on("rssiUpdate", entry.onRssiUpdate);

        try {
            if (peripheral.state !== "connected") await peripheral.connectAsync();

            const { characteristics } = await peripheral.discoverAllServicesAndCharacteristicsAsync();
            for (const characteristic of characteristics) {
                const name = bleCharacteristicFromUuid(characteristic.uuid);
                if (name) entry.characteristics.set(name, characteristic);
            }

            await this.#readInitial(peripheralId, entry);
            await this.#subscribe(peripheralId, entry);
            this.#startRssiPolling(peripheralId, entry);
        } catch (error) {
            await this.#cleanupConnection(peripheralId, entry);
            throw new HaritoraXError("CONNECTION_FAILED", `Failed to open BLE peripheral "${peripheralId}"`, {
                cause: error,
            });
        }
    }

    async close(peripheralId: string): Promise<void> {
        const entry = this.#open.get(peripheralId);
        if (!entry) return;

        await this.#cleanupConnection(peripheralId, entry);
    }

    async read(peripheralId: string, characteristic: BleCharacteristic): Promise<Uint8Array | undefined> {
        const instance = this.#open.get(peripheralId)?.characteristics.get(characteristic);
        if (!instance) return undefined;

        const buffer = await instance.readAsync();
        return new Uint8Array(buffer);
    }

    async write(peripheralId: string, characteristic: BleCharacteristic, data: Uint8Array): Promise<void> {
        const instance = this.#open.get(peripheralId)?.characteristics.get(characteristic);
        if (!instance) {
            throw new HaritoraXError("NOT_SUPPORTED", `Characteristic "${characteristic}" is not available`);
        }

        const withoutResponse = instance.properties.includes("writeWithoutResponse");

        try {
            await instance.writeAsync(Buffer.from(data), withoutResponse);
        } catch (error) {
            throw new HaritoraXError("WRITE_FAILED", `Failed to write "${characteristic}" to ${peripheralId}`, {
                cause: error,
            });
        }
    }

    onData(handler: (peripheralId: string, characteristic: BleCharacteristic, data: Uint8Array) => void): Unsubscribe {
        this.#dataHandlers.add(handler);
        return () => this.#dataHandlers.delete(handler);
    }

    onRssi(handler: (peripheralId: string, rssi: number) => void): Unsubscribe {
        this.#rssiHandlers.add(handler);
        return () => this.#rssiHandlers.delete(handler);
    }

    onLost(handler: (peripheralId: string, reason: DisconnectReason) => void): Unsubscribe {
        this.#lostHandlers.add(handler);
        return () => this.#lostHandlers.delete(handler);
    }

    async dispose(): Promise<void> {
        for (const timer of this.#rssiTimers.values()) clearInterval(timer);
        this.#rssiTimers.clear();

        await withTimeout(this.#noble.stopScanningAsync(), 5_000, "Timed out stopping BLE scan").catch(() => undefined);

        await Promise.all([...this.#open.keys()].map((peripheralId) => this.close(peripheralId)));

        this.#dataHandlers.clear();
        this.#lostHandlers.clear();
        this.#rssiHandlers.clear();
        this.#peripherals.clear();
        this.#noble.stop();
    }

    #startRssiPolling(peripheralId: string, entry: OpenPeripheral): void {
        if (this.#rssiPollMs <= 0) return;

        // initial RSSI update
        entry.peripheral
            .updateRssiAsync()
            .then((rssi) => {
                for (const handler of [...this.#rssiHandlers]) handler(peripheralId, rssi);
            })
            .catch(() => undefined);

        const timer = setInterval(() => {
            if (!this.#open.has(peripheralId)) {
                this.#stopRssiPolling(peripheralId);
                return;
            }

            entry.peripheral
                .updateRssiAsync()
                .then((rssi) => {
                    for (const handler of [...this.#rssiHandlers]) handler(peripheralId, rssi);
                })
                .catch((error: unknown) => {
                    this.#log?.debug(`RSSI update failed for ${peripheralId}`, { error: String(error) });
                });
        }, this.#rssiPollMs);

        this.#rssiTimers.set(peripheralId, timer);
    }

    #stopRssiPolling(peripheralId: string): void {
        const timer = this.#rssiTimers.get(peripheralId);
        if (timer === undefined) return;

        clearInterval(timer);
        this.#rssiTimers.delete(peripheralId);
    }

    async #readInitial(peripheralId: string, entry: OpenPeripheral): Promise<void> {
        for (const characteristic of INITIAL_READS) {
            const instance = entry.characteristics.get(characteristic);
            if (!instance) continue;

            try {
                const value = await instance.readAsync();
                this.#emit(peripheralId, characteristic, new Uint8Array(value));
            } catch (error) {
                this.#log?.debug(`Failed to read "${characteristic}" from ${peripheralId}`, { error: String(error) });
            }
        }
    }

    async #subscribe(peripheralId: string, entry: OpenPeripheral): Promise<void> {
        for (const [characteristic, instance] of entry.characteristics) {
            const properties = instance.properties;
            if (!properties.includes("notify") && !properties.includes("indicate")) continue;

            const handler = (data: Buffer, isNotification: boolean): void => {
                if (!isNotification) return;
                this.#emit(peripheralId, characteristic, new Uint8Array(data));
            };

            instance.on("data", handler);
            entry.subscriptions.push({ characteristic: instance, handler });

            try {
                await instance.subscribeAsync();
            } catch (error) {
                this.#log?.warn(`Failed to subscribe to "${characteristic}" on ${peripheralId}`, {
                    error: String(error),
                });
            }
        }
    }

    async #cleanupConnection(peripheralId: string, entry: OpenPeripheral): Promise<void> {
        entry.intentional = true;
        if (entry.onDisconnect) entry.peripheral.removeListener("disconnect", entry.onDisconnect);
        if (entry.onRssiUpdate) entry.peripheral.removeListener("rssiUpdate", entry.onRssiUpdate);
        this.#stopRssiPolling(peripheralId);
        this.#open.delete(peripheralId);

        for (const { characteristic, handler } of entry.subscriptions) {
            characteristic.removeListener("data", handler);
            await characteristic.unsubscribeAsync().catch((error: unknown) => {
                this.#log?.debug(`Failed to unsubscribe from ${peripheralId}`, { error: String(error) });
            });
        }

        await entry.peripheral.disconnectAsync().catch((error: unknown) => {
            this.#log?.debug(`Failed to disconnect from ${peripheralId}`, { error: String(error) });
        });
    }

    #emit(peripheralId: string, characteristic: BleCharacteristic, data: Uint8Array): void {
        for (const handler of [...this.#dataHandlers]) handler(peripheralId, characteristic, data);
    }
}

function createNobleBackend(options: NobleBleOptions = {}): BleBackend {
    const binding = resolveBinding(options.binding);
    const module = loadNoble();
    const noble = module.withBindings(binding);

    return new NobleBleBackend(noble, options.rssiPollMs ?? 0, options.logger);
}

function loadNoble(): NobleModule {
    try {
        const require = createRequire(import.meta.url);
        return require("@stoprocent/noble") as NobleModule;
    } catch (error) {
        throw new HaritoraXError("LINK_UNAVAILABLE", 'BLE requires the optional "@stoprocent/noble" package', {
            cause: error,
        });
    }
}

function resolveBinding(requested: NobleBleOptions["binding"]): NobleBinding {
    if (requested && requested !== "auto") return requested;

    if (process.platform === "win32") return "win";
    if (process.platform === "darwin") return "mac";
    if (process.platform === "linux") return "dbus";

    throw new HaritoraXError("LINK_UNAVAILABLE", `BLE is not supported on ${process.platform}`);
}

function waitForScanEnd(signal: AbortSignal | undefined, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve();
            return;
        }

        function finish(): void {
            clearTimeout(timer);
            signal?.removeEventListener("abort", finish);
            resolve();
        }

        const timer = setTimeout(finish, timeoutMs);
        signal?.addEventListener("abort", finish, { once: true });
    });
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new HaritoraXError("LINK_UNAVAILABLE", message)), timeoutMs);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

interface OpenPeripheral {
    peripheral: Peripheral;
    characteristics: Map<BleCharacteristic, Characteristic>;
    subscriptions: Array<{ characteristic: Characteristic; handler: (data: Buffer, isNotification: boolean) => void }>;
    intentional: boolean;
    onDisconnect?: (reason: number | string) => void;
    onRssiUpdate?: (rssi: number) => void;
}
