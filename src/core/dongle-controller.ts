import { HaritoraXError } from "../lib/errors.js";
import type { Emitter } from "../lib/emitter.js";
import type { Logger } from "../lib/logging.js";
import { endpointSlotKey, type DeviceRegistry } from "./device-registry.js";
import { PairingTracker } from "./pairing.js";
import {
    bodyPartOfTracker,
    bodyPartsFor,
    decodeTrackerRssi,
    DongleButtonState,
    dongleSettingsCommand,
    isButtonDebounced,
    isDongleSlot,
    isRssiLost,
    isValidChannel,
    pairCommands,
    parseChannel,
    parseDongleButtons,
    parsePairingResult,
    parseTrackerId,
    setChannelCommand,
    splitDongleImu,
    unpairCommands,
} from "../protocol/dongle.js";
import { decodeImu } from "../protocol/imu.js";
import { decodeSettings, modelFromFirmware, parseBattery, parseInfo } from "../protocol/messages.js";
import type { BodyPart, ConnectionKind, DeviceSnapshot, ImuRole, TrackerSettings } from "../types.js";

const PLACEHOLDER_SERIAL = "A00000";
const PAIRING_COMMAND_DELAY_MS = 1_000;
const PAIRING_TIMEOUT_MS = 10_000;

export interface DongleControllerOptions {
    emitter: Emitter;
    log: Logger;
    registry: DeviceRegistry;
    isOpen: (endpointId: string) => boolean;
    connectionKind: (endpointId: string) => ConnectionKind;
    write: (endpointId: string, command: string) => Promise<void>;
    onChannel: (endpointId: string, channel: number) => void;
    buttonDebounceMs?: number;
}

export class DongleController {
    readonly #emitter: Emitter;
    readonly #log: Logger;
    readonly #registry: DeviceRegistry;
    readonly #isOpen: (endpointId: string) => boolean;
    readonly #connectionKind: (endpointId: string) => ConnectionKind;
    readonly #write: (endpointId: string, command: string) => Promise<void>;
    readonly #onChannel: (endpointId: string, channel: number) => void;

    readonly #channels = new Map<string, number>();
    // pending/current dongle identity, keyed by endpointId:slot
    readonly #identities = new Map<string, TrackerIdentity>();
    readonly #buttons = new Map<string, DongleButtonState>();
    readonly #lastButtonPress = new Map<string, number>();
    readonly #buttonDebounceMs: number;
    readonly #pairings = new PairingTracker();

    constructor(options: DongleControllerOptions) {
        this.#emitter = options.emitter;
        this.#log = options.log;
        this.#registry = options.registry;
        this.#isOpen = options.isOpen;
        this.#connectionKind = options.connectionKind;
        this.#write = options.write;
        this.#onChannel = options.onChannel;
        this.#buttonDebounceMs = options.buttonDebounceMs ?? 200;
    }

    /*
     * dongle control
     */

    async pair(endpointId: string, slot: string | number): Promise<void> {
        const { portId, channel } = this.#pairingSlot(endpointId, slot);
        if (this.#pairings.has(endpointId)) {
            throw new HaritoraXError("BUSY", `Pairing is already in progress on ${endpointId}`);
        }

        const completion = this.#pairings.wait(endpointId, PAIRING_TIMEOUT_MS);

        try {
            await this.#writeSequence(endpointId, pairCommands(channel, portId));
        } catch (error) {
            this.#pairings.cancel(endpointId);
            throw error;
        }

        const result = await completion;
        if (result === "timeout") {
            throw new HaritoraXError("TIMEOUT", `Pairing on ${endpointId} timed out`);
        }

        if (result !== "paired") {
            throw new HaritoraXError("CONNECTION_FAILED", `Pairing on ${endpointId} was cancelled`);
        }

        await this.#write(endpointId, setChannelCommand(channel));
        await this.#write(endpointId, `r${portId}:`);

        this.#emitter.emit("paired", { endpointId, slot: portId });
        this.#log.info(`Paired ${endpointId}:${portId}`);
    }

    async unpair(endpointId: string, slot: string | number): Promise<void> {
        const { portId, channel } = this.#pairingSlot(endpointId, slot);

        await this.#writeSequence(endpointId, unpairCommands(channel, portId));

        this.#forgetIdentity(endpointId, portId);
        this.#emitter.emit("unpaired", { endpointId, slot: portId });
        this.#log.info(`Unpaired ${endpointId}:${portId}`);
    }

    getChannel(endpointId: string): number | undefined {
        return this.#channels.get(endpointId);
    }

    async setChannel(endpointId: string, channel: number): Promise<void> {
        if (!isValidChannel(channel)) {
            throw new HaritoraXError("NOT_SUPPORTED", `Channel must be an integer between 1 and 10, got ${channel}`);
        }

        if (!this.#isOpen(endpointId)) {
            throw new HaritoraXError("NOT_CONNECTED", `${endpointId} is not connected`);
        }

        await this.#write(endpointId, setChannelCommand(channel));
        this.#updateChannel(endpointId, channel);
    }

    async setSettings(endpointId: string, slot: string, settings: TrackerSettings): Promise<void> {
        if (!this.#isOpen(endpointId)) {
            throw new HaritoraXError("NOT_CONNECTED", `${endpointId} is not connected`);
        }

        await this.#write(endpointId, dongleSettingsCommand(slot, settings));

        const device = this.#registry.deviceAt(endpointId, slot);
        if (device) this.#registry.setSettings(device.deviceId, settings);

        this.#log.info(`Applied settings to ${endpointId}:${slot}`);
    }

    async powerOff(endpointId: string, slot: string, settings: TrackerSettings): Promise<void> {
        if (!this.#isOpen(endpointId)) {
            throw new HaritoraXError("NOT_CONNECTED", `${endpointId} is not connected`);
        }

        const command = dongleSettingsCommand(slot, settings, 2);
        const restore = dongleSettingsCommand(slot, settings, 0);
        await this.#write(endpointId, command);
        await delay(150);
        await this.#write(endpointId, restore);

        this.#log.info(`Powering off ${endpointId}:${slot}`);
    }

    // swaps to BLE
    async switchCommunication(endpointId: string, slot: string, settings: TrackerSettings): Promise<void> {
        if (!this.#isOpen(endpointId)) {
            throw new HaritoraXError("NOT_CONNECTED", `${endpointId} is not connected`);
        }

        const command = dongleSettingsCommand(slot, settings, 1);
        const restore = dongleSettingsCommand(slot, settings, 0);
        await this.#write(endpointId, command);
        await delay(150);
        await this.#write(endpointId, restore);

        this.#log.info(`Switching ${endpointId}:${slot} to BLE`);
    }

    /*
     * frame handling
     */

    handleFrame(endpointId: string, name: string, slot: string | undefined, payload: string): void {
        // no slot means it's a frame for the dongle itself, not a tracker
        if (!slot) {
            this.#onDongleFrame(endpointId, name, payload);
            return;
        }

        switch (name) {
            case "i":
                this.#onInfo(endpointId, slot, payload);
                break;
            case "v":
                this.#onBattery(endpointId, slot, payload);
                break;
            case "o":
                this.#onSettings(endpointId, slot, payload);
                break;
            case "x":
                this.#onImu(endpointId, slot, payload);
                break;
            case "r":
                this.#onIdentity(endpointId, slot, payload);
                break;
            case "a":
                this.#onTrackerStatus(endpointId, slot, payload);
                break;
        }
    }

    forgetEndpoint(endpointId: string): void {
        this.#channels.delete(endpointId);
        this.#pairings.cancel(endpointId);

        const prefix = `${endpointId}:`;
        for (const key of [...this.#identities.keys()]) {
            if (key.startsWith(prefix)) {
                this.#identities.delete(key);
                this.#buttons.delete(key);
            }
        }

        for (const key of this.#lastButtonPress.keys()) {
            if (key.startsWith(prefix)) this.#lastButtonPress.delete(key);
        }
    }

    dispose(): void {
        this.#pairings.cancelAll();
        this.#channels.clear();
        this.#identities.clear();
        this.#buttons.clear();
        this.#lastButtonPress.clear();
    }

    /*
     * internals
     */

    #pairingSlot(endpointId: string, slot: string | number): { portId: "0" | "1"; channel: number } {
        const portId = String(slot);
        if (!isDongleSlot(portId)) {
            throw new HaritoraXError("NOT_SUPPORTED", `Dongle slot must be 0 or 1, got "${portId}"`);
        }

        if (!this.#isOpen(endpointId)) {
            throw new HaritoraXError("NOT_CONNECTED", `${endpointId} is not connected`);
        }

        const channel = this.#channels.get(endpointId);
        if (channel === undefined) {
            throw new HaritoraXError("NOT_CONNECTED", `Channel for ${endpointId} is not known yet`);
        }

        return { portId, channel };
    }

    async #writeSequence(endpointId: string, commands: readonly string[]): Promise<void> {
        for (const [i, command] of commands.entries()) {
            if (i > 0) await delay(PAIRING_COMMAND_DELAY_MS);
            await this.#write(endpointId, command);
        }
    }

    #onDongleFrame(endpointId: string, identifier: string, payload: string): void {
        if (identifier === "o") {
            const channel = parseChannel(payload);
            if (channel !== undefined) this.#updateChannel(endpointId, channel);
            return;
        }

        if (identifier === "r" && parsePairingResult(payload) && this.#pairings.settle(endpointId, "paired")) {
            this.#log.info(`Pairing completed on ${endpointId}`);
        }
    }

    #onTrackerStatus(endpointId: string, slot: string, payload: string): void {
        const device = this.#registry.deviceAt(endpointId, slot);
        if (!device) return;

        const tracker = device.trackers[0];
        if (!tracker) return;

        // mark tracker lost if `a(x):` frame is 7f7f7f7f7f7f
        if (isRssiLost(payload)) {
            // make sure to not mark tracker lost if its BLE (not serial/dongle)
            if (device.connection !== this.#connectionKind(endpointId)) return;

            this.#registry.markTrackerLost(tracker.trackerId, "remote");
            this.#log.warn(`Tracker ${tracker.trackerId} lost, dongle ${endpointId}:${slot} is searching`);
            return;
        }

        this.#registry.trackerSeen(tracker.trackerId);

        const decoded = decodeTrackerRssi(payload);
        if (!decoded) return;
        this.#registry.setRssi(tracker.trackerId, decoded.dongle, decoded.sensor);
    }

    #onInfo(endpointId: string, slot: string, payload: string): void {
        const parsed = parseInfo(payload);
        if (!parsed) return;

        const serial = parsed.serialNumber;
        if (serial === PLACEHOLDER_SERIAL) return;

        const imuCount = parsed.imuCount ?? 1;
        const model = modelFromFirmware(parsed.model);
        const identity = this.#identities.get(endpointSlotKey(endpointId, slot));
        const parts = identity ? bodyPartsFor(identity.bodyPart, imuCount) : unassignedParts(imuCount);

        this.#registry.register({
            deviceId: serial,
            endpointId,
            slot,
            model,
            firmwareModel: parsed.model,
            version: parsed.version,
            reportedImuCount: parsed.imuCount,
            connection: this.#connectionKind(endpointId),
            parts,
        });
    }

    // "r0:"/"r1:" replies identify the tracker currently paired to that slot and button states
    // 5th bit is tracker id, 7th and 10th bit are main/sub button states
    #onIdentity(endpointId: string, slot: string, payload: string): void {
        const dongleId = parseTrackerId(payload);
        if (!dongleId) return;

        const bodyPart = bodyPartOfTracker(dongleId);
        if (!bodyPart) {
            this.#log.debug(`Unknown tracker id "${dongleId}" on ${endpointId}:${slot}`);
            return;
        }

        const key = endpointSlotKey(endpointId, slot);
        const identity = this.#identities.get(key);

        // register identity on first discovery
        if (!identity || identity.dongleId !== dongleId || identity.bodyPart !== bodyPart) {
            this.#identities.set(key, { dongleId, bodyPart });
            this.#log.info(`Identified ${endpointId}:${slot} as ${bodyPart} (tracker ${dongleId})`);
        }

        // update body parts and device if identity is new
        const device = this.#registry.deviceAt(endpointId, slot);
        if (device) this.#registry.setTrackers(device.deviceId, bodyPartsFor(bodyPart, device.imuCount ?? 1));

        // parse and emit button state changes on every `r(x):` frame
        const buttonKey = endpointSlotKey(endpointId, slot);
        const buttonState = this.#buttons.get(buttonKey) ?? { main: 0, sub: 0 };
        const updated = parseDongleButtons(payload, buttonState);
        this.#buttons.set(buttonKey, updated);

        if (!updated.pressed || !device) return;

        if (!isButtonDebounced(buttonKey, updated.pressed, this.#lastButtonPress, Date.now(), this.#buttonDebounceMs)) {
            this.#emitter.emit("button", { deviceId: device.deviceId, button: updated.pressed });
        }
    }

    #onBattery(endpointId: string, slot: string, payload: string): void {
        const parsed = parseBattery(payload);
        if (!parsed) return;

        const device = this.#registry.deviceAt(endpointId, slot);
        if (!device) return;

        this.#registry.setBattery(device.deviceId, {
            deviceId: device.deviceId,
            level: parsed.level,
            voltage: parsed.voltage,
            chargeStatus: parsed.chargeStatus,
            timestamp: Date.now(),
        });
    }

    #onSettings(endpointId: string, slot: string, payload: string): void {
        const settings = decodeSettings(payload);
        if (!settings) return;

        const device = this.#registry.deviceAt(endpointId, slot);
        if (!device) return;

        this.#registry.setSettings(device.deviceId, settings);
    }

    #onImu(endpointId: string, slot: string, payload: string): void {
        const device = this.#registry.deviceAt(endpointId, slot);
        if (!device) return; // drop packet if device is unidentified still

        for (const slice of splitDongleImu(payload, device.trackers.length)) {
            this.#emitSample(device, slice.index, slice.role, decodeImu(slice.payload, device.model, slice.magByte));
        }
    }

    #emitSample(device: DeviceSnapshot, imuIndex: number, role: ImuRole, decoded: ReturnType<typeof decodeImu>): void {
        if (!decoded) return;

        const tracker = device.trackers[imuIndex];
        if (!tracker) return;

        if (!this.#registry.trackerSeen(tracker.trackerId)) return;

        this.#emitter.emit("imu", {
            trackerId: tracker.trackerId,
            deviceId: device.deviceId,
            bodyPart: tracker.bodyPart,
            role,
            rotation: decoded.rotation,
            acceleration: decoded.acceleration,
            ...(decoded.ankleAngle === undefined ? {} : { ankleAngle: decoded.ankleAngle }),
            timestamp: Date.now(),
        });

        if (decoded.magStatus) this.#registry.setMag(tracker.trackerId, decoded.magStatus);
    }

    #updateChannel(endpointId: string, channel: number): void {
        if (this.#channels.get(endpointId) === channel) return;

        this.#channels.set(endpointId, channel);
        this.#onChannel(endpointId, channel);
    }

    #forgetIdentity(endpointId: string, slot: string): void {
        this.#identities.delete(endpointSlotKey(endpointId, slot));

        const device = this.#registry.deviceAt(endpointId, slot);
        if (!device) return;

        this.#registry.setTrackers(device.deviceId, unassignedParts(device.imuCount));
    }
}

/*
 * helpers
 */

function unassignedParts(count: number): BodyPart[] {
    return Array.from({ length: count }, () => "unassigned");
}

function delay(ms: number): Promise<void> {
    return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

interface TrackerIdentity {
    dongleId: string;
    bodyPart: BodyPart;
}
