import { createRequire } from "node:module";
import { HaritoraXError } from "../../lib/errors.js";
import type { Logger } from "../../lib/logging.js";
import { modelFromFirmware } from "../../protocol/codec/messages.js";
import { bleCharacteristicFromUuid, bleText, parseBleDeviceName, type BleCharacteristic } from "../../protocol/endpoint/ble.js";
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

const STREAM_IDENTITY_READS: readonly BleCharacteristic[] = Object.freeze([
    "serial-number",
    "software-revision",
    "number-of-imu",
    "model-number",
    "body-part",
]);
const DEFERRED_READS: readonly BleCharacteristic[] = Object.freeze([
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
const DEFAULT_OPERATION_TIMEOUT_MS = 10_000;
const DISCONNECT_TIMEOUT_MS = 2_000;

export function createBleConnection(options: NobleBleOptions = {}): BleConnection {
    return new BleConnection(createNobleBackend(options), options);
}

class NobleBleBackend implements BleBackend {
    readonly #noble: Noble;
    readonly #log: Logger | undefined;
    readonly #rssiPollMs: number;
    readonly #binding: NobleBinding;
    readonly #operationTimeoutMs: number;

    readonly #peripherals = new Map<string, Peripheral>();
    readonly #open = new Map<string, OpenPeripheral>();
    readonly #opening = new Map<string, Promise<void>>();
    readonly #closing = new Map<string, Promise<void>>();
    readonly #generations = new Map<string, number>();

    readonly #dataHandlers = new Set<(peripheralId: string, characteristic: BleCharacteristic, data: Uint8Array) => void>();
    readonly #lostHandlers = new Set<(peripheralId: string, reason: DisconnectReason) => void>();
    readonly #rssiHandlers = new Set<(peripheralId: string, rssi: number) => void>();

    readonly #rssiTimers = new Map<string, ReturnType<typeof setInterval>>();

    constructor(
        noble: Noble,
        rssiPollMs: number,
        log: Logger | undefined,
        binding: NobleBinding,
        operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
    ) {
        this.#noble = noble;
        this.#rssiPollMs = rssiPollMs;
        this.#log = log;
        this.#binding = binding;
        this.#operationTimeoutMs = operationTimeoutMs;
    }

    async scan(options?: ListOptions): Promise<BlePeripheralSummary[]> {
        const scanStartedAt = Date.now();
        const found = new Map<string, BlePeripheralSummary>();
        let finishForTarget!: () => void;
        const targetFound = new Promise<void>((resolve) => (finishForTarget = resolve));
        const onDiscover = (peripheral: Peripheral): void => {
            this.#peripherals.set(peripheral.id, peripheral);

            const existing = found.get(peripheral.id);
            const localName = peripheral.advertisement?.localName || existing?.localName;
            const rssi = peripheral.rssi !== 0 ? peripheral.rssi : existing?.rssi;

            found.set(peripheral.id, {
                id: peripheral.id,
                ...(localName ? { localName } : {}),
                ...(rssi === undefined ? {} : { rssi }),
                connectable: peripheral.connectable,
                serviceUuids: [...(peripheral.advertisement?.serviceUuids ?? [])],
            });
            if (peripheral.id === options?.targetEndpointId) finishForTarget();
        };

        this.#noble.on("discover", onDiscover);
        this.#log?.debug("Starting BLE scan", { binding: this.#binding, timeoutMs: options?.timeoutMs ?? 5_000 });

        try {
            const timeoutMs = options?.timeoutMs ?? 5_000;
            const powerWaitStartedAt = Date.now();
            await withTimeout(
                this.#noble.waitForPoweredOnAsync(timeoutMs),
                timeoutMs,
                "Timed out waiting for Bluetooth power",
                options?.signal,
            );
            this.#log?.debug("Bluetooth adapter is powered on", { elapsedMs: Date.now() - powerWaitStartedAt });
            if (options?.signal?.aborted) return [];

            const scanStartStartedAt = Date.now();
            await withTimeout(
                this.#noble.startScanningAsync([], false),
                timeoutMs,
                "Timed out starting BLE scan",
                options?.signal,
            );
            this.#log?.debug("BLE scan started", { elapsedMs: Date.now() - scanStartStartedAt });
            await waitForScanEnd(options?.signal, timeoutMs, options?.targetEndpointId ? targetFound : undefined);
        } catch (error) {
            this.#log?.debug("BLE scan failed", { elapsedMs: Date.now() - scanStartedAt, error: String(error) });
            throw error;
        } finally {
            this.#noble.removeListener("discover", onDiscover);
            await withTimeout(this.#noble.stopScanningAsync(), options?.timeoutMs ?? 5_000, "Timed out stopping BLE scan").catch(
                (error: unknown) => {
                    this.#log?.debug("Failed to stop BLE scanning", { error: String(error) });
                },
            );
        }

        const results = [...found.values()].filter(
            (peripheral) => !options?.targetEndpointId || peripheral.id === options.targetEndpointId,
        );
        const candidates = results.filter((peripheral) => parseBleDeviceName(peripheral.localName));
        this.#log?.debug("BLE scan completed", {
            elapsedMs: Date.now() - scanStartedAt,
            peripheralCount: results.length,
            haritoraxCandidateCount: candidates.length,
            haritoraxCandidates: candidates.map(({ id, localName, rssi, connectable, serviceUuids }) => ({
                id,
                localName,
                rssi,
                connectable,
                serviceUuids,
            })),
        });
        return results;
    }

    async open(peripheralId: string): Promise<void> {
        const opening = this.#opening.get(peripheralId);
        if (opening) return opening;
        if (this.#open.has(peripheralId)) return;

        const generation = (this.#generations.get(peripheralId) ?? 0) + 1;
        this.#generations.set(peripheralId, generation);
        const operation = (async () => {
            await this.#closing.get(peripheralId);
            await this.#openPeripheral(peripheralId, generation);
        })();
        const tracked = operation.finally(() => {
            if (this.#opening.get(peripheralId) === tracked) this.#opening.delete(peripheralId);
        });
        this.#opening.set(peripheralId, tracked);
        return tracked;
    }

    async #openPeripheral(peripheralId: string, generation: number): Promise<void> {
        const peripheral = this.#peripherals.get(peripheralId);
        if (!peripheral) {
            throw new HaritoraXError("DEVICE_NOT_FOUND", `Unknown BLE peripheral "${peripheralId}", run discover() first`);
        }

        let rejectDisconnected!: (error: Error) => void;
        const disconnected = new Promise<never>((_resolve, reject) => (rejectDisconnected = reject));
        void disconnected.catch(() => undefined);
        const entry: OpenPeripheral = {
            peripheral,
            characteristics: new Map(),
            subscriptions: [],
            subscribed: [],
            intentional: false,
            disconnected,
            openedAt: Date.now(),
        };
        entry.onDisconnect = (reason: number | string): void => {
            if (entry.intentional) return;

            const error = new HaritoraXError("CONNECTION_FAILED", `BLE peripheral "${peripheralId}" disconnected`, {
                cause: reason,
            });
            rejectDisconnected(error);
            this.#log?.warn(`Lost BLE peripheral ${peripheralId}`, {
                localName: peripheral.advertisement?.localName,
                reason: String(reason),
                connectedForMs: Date.now() - entry.openedAt,
                subscribed: [...entry.subscribed],
            });
            void this.#cleanupConnection(peripheralId, entry, false);
            for (const handler of [...this.#lostHandlers]) handler(peripheralId, "remote");
        };

        entry.onRssiUpdate = (rssi: number): void => {
            for (const handler of [...this.#rssiHandlers]) handler(peripheralId, rssi);
        };

        this.#open.set(peripheralId, entry);
        peripheral.on("disconnect", entry.onDisconnect);
        peripheral.on("rssiUpdate", entry.onRssiUpdate);

        try {
            const totalStartedAt = Date.now();
            this.#log?.debug("Connecting to BLE peripheral", {
                peripheralId,
                binding: this.#binding,
                localName: peripheral.advertisement?.localName,
                rssi: peripheral.rssi,
                state: peripheral.state,
                mtu: peripheral.mtu,
            });
            const connectStartedAt = Date.now();
            if (peripheral.state !== "connected") {
                const connecting = peripheral.connectAsync();
                try {
                    await this.#raceDisconnect(entry, connecting, peripheralId, "connect");
                } catch (error) {
                    void connecting
                        .then(async () => {
                            if (this.#generations.get(peripheralId) === generation && !this.#open.has(peripheralId)) {
                                await this.#disconnectPeripheral(
                                    peripheralId,
                                    peripheral,
                                    () => this.#generations.get(peripheralId) === generation,
                                );
                            }
                        })
                        .catch(() => undefined);
                    throw error;
                }
            }
            this.#assertOpenEntry(peripheralId, entry);
            this.#log?.debug("Connected to BLE peripheral", { peripheralId, elapsedMs: Date.now() - connectStartedAt });

            const discoveryStartedAt = Date.now();
            const { services, characteristics } = await this.#raceDisconnect(
                entry,
                peripheral.discoverAllServicesAndCharacteristicsAsync(),
                peripheralId,
                "GATT discovery",
            );
            this.#assertOpenEntry(peripheralId, entry);
            for (const characteristic of characteristics) {
                const name = bleCharacteristicFromUuid(characteristic.uuid);
                if (name) entry.characteristics.set(name, characteristic);
            }
            if (this.#log?.enabled("debug")) {
                this.#log.debug("Discovered BLE GATT database", {
                    peripheralId,
                    elapsedMs: Date.now() - discoveryStartedAt,
                    serviceCount: services.length,
                    characteristicCount: characteristics.length,
                    recognizedCharacteristicCount: entry.characteristics.size,
                    unknownCharacteristicCount: characteristics.filter(
                        (characteristic) => !bleCharacteristicFromUuid(characteristic.uuid),
                    ).length,
                    characteristics: characteristics.map((characteristic) => describeCharacteristic(characteristic)),
                    services: services.map((service) => ({
                        uuid: service.uuid,
                        name: service.name,
                        characteristics: service.characteristics.map((characteristic) => describeCharacteristic(characteristic)),
                    })),
                });
            }

            const identityReadsStartedAt = Date.now();
            const identityValues = await this.#readInitial(peripheralId, entry, STREAM_IDENTITY_READS);
            this.#assertOpenEntry(peripheralId, entry);
            const serial = bleText(identityValues.get("serial-number") ?? new Uint8Array(0));
            const firmwareModel = bleText(identityValues.get("model-number") ?? new Uint8Array(0));
            let identityValid = Boolean(serial && firmwareModel);
            if (identityValid) {
                try {
                    modelFromFirmware(firmwareModel);
                } catch {
                    identityValid = false;
                }
            }
            if (!identityValid) {
                throw new HaritoraXError(
                    "CONNECTION_FAILED",
                    `BLE peripheral "${peripheralId}" did not provide a valid serial number and supported model`,
                );
            }
            this.#log?.debug("Finished essential BLE identity reads", {
                peripheralId,
                elapsedMs: Date.now() - identityReadsStartedAt,
                requested: STREAM_IDENTITY_READS.length,
                available: STREAM_IDENTITY_READS.filter((name) => entry.characteristics.has(name)),
                missing: STREAM_IDENTITY_READS.filter((name) => !entry.characteristics.has(name)),
            });

            const sensorSubscriptionsStartedAt = Date.now();
            await this.#subscribe(peripheralId, entry, ["sensor", "sensor2"]);
            this.#assertOpenEntry(peripheralId, entry);
            const sensorSubscriptions = entry.subscribed.filter((name) => name === "sensor" || name === "sensor2");
            if (sensorSubscriptions.length === 0) {
                throw new HaritoraXError(
                    "CONNECTION_FAILED",
                    `BLE peripheral "${peripheralId}" has no usable sensor notification characteristic`,
                );
            }
            this.#log?.debug("Subscribed to BLE sensor notifications", {
                peripheralId,
                elapsedMs: Date.now() - sensorSubscriptionsStartedAt,
                subscribed: entry.subscribed.filter((name) => name === "sensor" || name === "sensor2"),
            });

            const metadataReadsStartedAt = Date.now();
            await this.#readInitial(peripheralId, entry, DEFERRED_READS);
            this.#assertOpenEntry(peripheralId, entry);
            this.#log?.debug("Finished deferred BLE metadata reads", {
                peripheralId,
                elapsedMs: Date.now() - metadataReadsStartedAt,
                requested: DEFERRED_READS.length,
                available: DEFERRED_READS.filter((name) => entry.characteristics.has(name)),
                missing: DEFERRED_READS.filter((name) => !entry.characteristics.has(name)),
            });

            const metadataSubscriptionsStartedAt = Date.now();
            const metadataSubscriptions = [...entry.characteristics.keys()].filter(
                (name) => name !== "sensor" && name !== "sensor2",
            );
            await this.#subscribe(peripheralId, entry, metadataSubscriptions);
            this.#assertOpenEntry(peripheralId, entry);
            this.#log?.debug("Finished BLE metadata subscriptions", {
                peripheralId,
                elapsedMs: Date.now() - metadataSubscriptionsStartedAt,
                subscribed: entry.subscribed.filter((name) => name !== "sensor" && name !== "sensor2"),
            });

            this.#startRssiPolling(peripheralId, entry);
            this.#log?.info(`BLE peripheral ready ${peripheralId}`, {
                localName: peripheral.advertisement?.localName,
                connectedInMs: Date.now() - totalStartedAt,
                subscribed: [...entry.subscribed],
            });
        } catch (error) {
            this.#log?.debug("BLE peripheral setup failed", {
                peripheralId,
                localName: peripheral.advertisement?.localName,
                error: String(error),
                subscribed: [...entry.subscribed],
            });
            await this.#cleanupConnection(peripheralId, entry);
            throw new HaritoraXError("CONNECTION_FAILED", `Failed to open BLE peripheral "${peripheralId}"`, {
                cause: error,
            });
        }
    }

    async close(peripheralId: string): Promise<void> {
        const opening = this.#opening.get(peripheralId);
        if (opening) await opening.catch(() => undefined);
        const entry = this.#open.get(peripheralId);
        if (!entry) return;

        await this.#cleanupConnection(peripheralId, entry);
    }

    async read(peripheralId: string, characteristic: BleCharacteristic): Promise<Uint8Array | undefined> {
        const entry = this.#open.get(peripheralId);
        if (!entry) return undefined;
        const instance = entry.characteristics.get(characteristic);
        if (!instance) return undefined;

        const buffer = await this.#raceDisconnect(entry, instance.readAsync(), peripheralId, `read ${characteristic}`);
        return new Uint8Array(buffer);
    }

    async readRssi(peripheralId: string): Promise<number> {
        const entry = this.#open.get(peripheralId);
        if (!entry) throw new HaritoraXError("NOT_CONNECTED", `BLE peripheral "${peripheralId}" is not open`);
        return this.#raceDisconnect(entry, entry.peripheral.updateRssiAsync(), peripheralId, "read RSSI");
    }

    async write(peripheralId: string, characteristic: BleCharacteristic, data: Uint8Array): Promise<void> {
        const entry = this.#open.get(peripheralId);
        if (!entry) throw new HaritoraXError("DEVICE_NOT_FOUND", `BLE peripheral "${peripheralId}" is not open`);
        const instance = entry.characteristics.get(characteristic);
        if (!instance) {
            throw new HaritoraXError("NOT_SUPPORTED", `Characteristic "${characteristic}" is not available`);
        }

        const withoutResponse = instance.properties.includes("writeWithoutResponse");

        try {
            await this.#raceDisconnect(
                entry,
                instance.writeAsync(Buffer.from(data), withoutResponse),
                peripheralId,
                `write ${characteristic}`,
            );
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

        await Promise.all([...this.#opening.values()].map((opening) => opening.catch(() => undefined)));
        await Promise.all([...this.#open.keys()].map((peripheralId) => this.close(peripheralId)));
        await Promise.all([...this.#closing.values()]);

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

    async #readInitial(
        peripheralId: string,
        entry: OpenPeripheral,
        reads: readonly BleCharacteristic[],
    ): Promise<Map<BleCharacteristic, Uint8Array>> {
        const values = new Map<BleCharacteristic, Uint8Array>();
        const succeeded: string[] = [];
        const failed: Array<{ characteristic: string; uuid: string; error: string }> = [];
        for (const characteristic of reads) {
            this.#assertOpenEntry(peripheralId, entry);
            const instance = entry.characteristics.get(characteristic);
            if (!instance) continue;

            try {
                const value = await this.#raceDisconnect(entry, instance.readAsync(), peripheralId, `read ${characteristic}`);
                this.#assertOpenEntry(peripheralId, entry);
                const bytes = new Uint8Array(value);
                values.set(characteristic, bytes);
                this.#emit(peripheralId, characteristic, bytes);
                succeeded.push(characteristic);
            } catch (error) {
                this.#log?.debug(`Failed to read "${characteristic}" from ${peripheralId}`, { error: String(error) });
                failed.push({ characteristic, uuid: instance.uuid, error: String(error) });
            }
        }
        this.#log?.debug("BLE initial read results", { peripheralId, succeeded, failed });
        return values;
    }

    async #subscribe(peripheralId: string, entry: OpenPeripheral, characteristics: readonly BleCharacteristic[]): Promise<void> {
        const unsupported: string[] = [];
        const failed: Array<{ characteristic: string; uuid: string; error: string }> = [];
        for (const characteristic of characteristics) {
            this.#assertOpenEntry(peripheralId, entry);
            const instance = entry.characteristics.get(characteristic);
            if (!instance) continue;
            const properties = instance.properties;
            if (!properties.includes("notify") && !properties.includes("indicate")) {
                unsupported.push(characteristic);
                continue;
            }

            const handler = (data: Buffer, isNotification: boolean): void => {
                if (!isNotification) return;
                this.#emit(peripheralId, characteristic, new Uint8Array(data));
            };

            instance.on("data", handler);
            entry.subscriptions.push({ characteristic: instance, handler });

            try {
                await this.#raceDisconnect(entry, instance.subscribeAsync(), peripheralId, `subscribe ${characteristic}`);
                this.#assertOpenEntry(peripheralId, entry);
                entry.subscribed.push(characteristic);
            } catch (error) {
                const detail = { characteristic, uuid: instance.uuid, error: String(error) };
                failed.push(detail);
                if (characteristic === "sensor" || characteristic === "sensor2") {
                    this.#log?.warn(`Failed to subscribe to BLE sensor characteristic "${characteristic}"`, {
                        peripheralId,
                        ...detail,
                    });
                } else {
                    this.#log?.debug(`Failed to subscribe to optional BLE characteristic "${characteristic}"`, {
                        peripheralId,
                        ...detail,
                    });
                }
            }
        }
        this.#log?.debug("BLE subscription results", { peripheralId, subscribed: [...entry.subscribed], unsupported, failed });
    }

    async #cleanupConnection(peripheralId: string, entry: OpenPeripheral, disconnect = true): Promise<void> {
        if (entry.cleanup) return entry.cleanup;

        entry.intentional = true;
        if (entry.onDisconnect) entry.peripheral.removeListener("disconnect", entry.onDisconnect);
        if (entry.onRssiUpdate) entry.peripheral.removeListener("rssiUpdate", entry.onRssiUpdate);
        if (this.#open.get(peripheralId) === entry) {
            this.#stopRssiPolling(peripheralId);
            this.#open.delete(peripheralId);
        }

        for (const { characteristic, handler } of entry.subscriptions) characteristic.removeListener("data", handler);

        entry.cleanup = disconnect ? this.#disconnectPeripheral(peripheralId, entry.peripheral) : Promise.resolve();
        return entry.cleanup;
    }

    #disconnectPeripheral(peripheralId: string, peripheral: Peripheral, shouldDisconnect = (): boolean => true): Promise<void> {
        const previous = this.#closing.get(peripheralId);
        const disconnect = async (): Promise<void> => {
            if (!shouldDisconnect()) return;

            await withTimeout(
                peripheral.disconnectAsync(),
                Math.min(this.#operationTimeoutMs, DISCONNECT_TIMEOUT_MS),
                `Timed out disconnecting from ${peripheralId}`,
            ).catch((error: unknown) => {
                this.#log?.debug(`Failed to disconnect from ${peripheralId}`, { error: String(error) });
            });
        };

        const operation = previous ? previous.then(disconnect) : disconnect();
        const tracked = operation.finally(() => {
            if (this.#closing.get(peripheralId) === tracked) this.#closing.delete(peripheralId);
        });
        this.#closing.set(peripheralId, tracked);
        return tracked;
    }

    async #raceDisconnect<T>(entry: OpenPeripheral, operation: Promise<T>, peripheralId: string, label: string): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
                () => reject(new HaritoraXError("TIMEOUT", `BLE ${label} timed out for "${peripheralId}"`)),
                this.#operationTimeoutMs,
            );
        });
        return Promise.race([operation, entry.disconnected, timeout]).finally(() => clearTimeout(timer));
    }

    #assertOpenEntry(peripheralId: string, entry: OpenPeripheral): void {
        if (entry.intentional || this.#open.get(peripheralId) !== entry) {
            throw new HaritoraXError("CONNECTION_FAILED", `BLE peripheral "${peripheralId}" disconnected while opening`);
        }
    }

    #emit(peripheralId: string, characteristic: BleCharacteristic, data: Uint8Array): void {
        for (const handler of [...this.#dataHandlers]) handler(peripheralId, characteristic, data);
    }
}

function createNobleBackend(options: NobleBleOptions = {}): BleBackend {
    const binding = resolveBinding(options.binding);
    const module = loadNoble(binding);
    const noble = module.withBindings(binding);

    return new NobleBleBackend(noble, options.rssiPollMs ?? 0, options.logger, binding, options.operationTimeoutMs);
}

function loadNoble(binding: NobleBinding): NobleModule {
    try {
        const require = createRequire(import.meta.url);
        if (binding === "dbus") restoreUtilIsError(require);
        return require("@stoprocent/noble") as NobleModule;
    } catch (error) {
        throw new HaritoraXError("LINK_UNAVAILABLE", 'BLE requires the optional "@stoprocent/noble" package', {
            cause: error,
        });
    }
}

function restoreUtilIsError(require: NodeJS.Require): void {
    const util = require("node:util") as typeof import("node:util") & {
        isError?: (value: unknown) => boolean;
    };

    // usocket@0.3.0 used by noble's optional D-Bus backend calls util.isError (remove in Node 24), so restoring it to avoid runtime errors
    if (typeof util.isError !== "function") {
        Object.defineProperty(util, "isError", { value: util.types.isNativeError });
    }
}

function resolveBinding(requested: string | undefined): NobleBinding {
    if (requested && requested !== "auto") {
        const binding = (["hci", "dbus", "mac", "win"] as const).find((candidate) => candidate === requested);
        if (binding) return binding;
        throw new HaritoraXError("NOT_SUPPORTED", `BLE binding "${requested}" is not supported`);
    }

    if (process.platform === "win32") return "win";
    if (process.platform === "darwin") return "mac";
    if (process.platform === "linux") return "dbus";

    throw new HaritoraXError("LINK_UNAVAILABLE", `BLE is not supported on ${process.platform}`);
}

function waitForScanEnd(signal: AbortSignal | undefined, timeoutMs: number, finishEarly?: Promise<void>): Promise<void> {
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
        void finishEarly?.then(finish);
    });
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");

    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new HaritoraXError("LINK_UNAVAILABLE", message)), timeoutMs);
                if (signal) {
                    onAbort = () => {
                        const reason: unknown = signal.reason;
                        reject(reason instanceof Error ? reason : new DOMException("The operation was aborted", "AbortError"));
                    };
                    signal.addEventListener("abort", onAbort, { once: true });
                }
            }),
        ]);
    } finally {
        clearTimeout(timer);
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    }
}

interface OpenPeripheral {
    peripheral: Peripheral;
    characteristics: Map<BleCharacteristic, Characteristic>;
    subscriptions: Array<{ characteristic: Characteristic; handler: (data: Buffer, isNotification: boolean) => void }>;
    subscribed: BleCharacteristic[];
    openedAt: number;
    intentional: boolean;
    disconnected: Promise<never>;
    cleanup?: Promise<void>;
    onDisconnect?: (reason: number | string) => void;
    onRssiUpdate?: (rssi: number) => void;
}

function describeCharacteristic(characteristic: Characteristic): Record<string, unknown> {
    const recognizedName = bleCharacteristicFromUuid(characteristic.uuid);
    return {
        uuid: characteristic.uuid,
        name: characteristic.name || recognizedName || "unknown",
        recognizedName,
        properties: [...characteristic.properties],
    };
}
