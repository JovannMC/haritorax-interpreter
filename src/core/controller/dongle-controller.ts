import { toByteArray as decodeBase64 } from "base64-js";
import { HaritoraXError } from "../../lib/errors.js";
import type { Emitter } from "../../lib/emitter.js";
import type { Logger } from "../../lib/logging.js";
import { endpointSlotKey, type DeviceRegistry } from "../device-registry.js";
import { PairingTracker } from "../pairing.js";
import {
    bodyPartCommands,
    bodyPartOfTracker,
    bodyPartsFor,
    decodeTrackerRssi,
    DongleButtonState,
    DongleRegister,
    dongleSettingsCommand,
    isButtonDebounced,
    isDongleSlot,
    isRssiLost,
    isSlotUnpaired,
    isValidChannel,
    pairCommands,
    parseChannel,
    parseDongleAccelAccuracy,
    parseDongleButtons,
    parseDongleRegister,
    parseTrackerId,
    setChannelCommand,
    splitDongleImuBytes,
    trackerIdOfBodyPart,
    unpairCommands,
} from "../../protocol/endpoint/dongle.js";
import { decodeImuBytes, decodeRange } from "../../protocol/codec/imu.js";
import {
    bodyPartNeedsUnlock,
    commandHoldMs,
    dongleCarriesTwoImus,
    dongleMayDropCommands,
    dongleReportsAccelAccuracy,
} from "../../protocol/firmware.js";
import { decodeSettings, modelFromFirmware, parseBattery, parseInfo } from "../../protocol/codec/messages.js";
import type { BodyPart, ConnectionKind, DeviceSnapshot, ImuRole, TrackerSettings } from "../../types.js";

const PLACEHOLDER_SERIAL = "A00000";
const PAIRING_COMMAND_DELAY_MS = 1_000;
const PAIRING_TIMEOUT_MS = 30_000;
const BODY_PART_STEP_DELAY_MS = 200;
const BODY_PART_TIMEOUT_MS = 2_000;
const SETTINGS_READ_TIMEOUT_MS = 2_000;
const PING_INTERVAL_MS = 1_000;

export interface DongleControllerOptions {
    emitter: Emitter;
    log: Logger;
    registry: DeviceRegistry;
    isOpen: (endpointId: string) => boolean;
    connectionKind: (endpointId: string) => ConnectionKind;
    hasBlePeer: (deviceId: string) => boolean;
    write: (endpointId: string, command: string) => Promise<void>;
    onChannel: (endpointId: string, channel: number) => void;
    buttonDebounceMs?: number;
    pairingTimeoutMs?: number;
}

export class DongleController {
    readonly #emitter: Emitter;
    readonly #log: Logger;
    readonly #registry: DeviceRegistry;
    readonly #isOpen: (endpointId: string) => boolean;
    readonly #connectionKind: (endpointId: string) => ConnectionKind;
    readonly #hasBlePeer: (deviceId: string) => boolean;
    readonly #write: (endpointId: string, command: string) => Promise<void>;
    readonly #onChannel: (endpointId: string, channel: number) => void;

    readonly #channels = new Map<string, number>();
    // pending/current dongle identity, keyed by endpointId:slot
    readonly #identities = new Map<string, TrackerIdentity>();
    readonly #buttons = new Map<string, DongleButtonState>();
    readonly #lastButtonPress = new Map<string, number>();
    readonly #buttonDebounceMs: number;
    readonly #pairingTimeoutMs: number;
    readonly #pairings = new PairingTracker();
    readonly #dongleVersions = new Map<string, string>();
    // endpoints that are in pairing mode
    readonly #pairingSlots = new Map<string, { slot: "0" | "1"; armed: boolean; wasUnpaired: boolean }>();
    // last `r:` register per endpoint
    readonly #registers = new Map<string, DongleRegister>();
    readonly #bodyPartWaits = new Map<string, BodyPartWait>();
    // last `oN:` frame the dongle echoed per endpoint:slot, the base for settings writes
    readonly #settingsEchoes = new Map<string, string>();
    readonly #settingsReads = new Map<string, SettingsRead>();
    readonly #latencies = new Map<string, number>();
    readonly #pingSentAt = new Map<string, number>();
    readonly #pingTimers = new Map<string, ReturnType<typeof setInterval>>();

    constructor(options: DongleControllerOptions) {
        this.#emitter = options.emitter;
        this.#log = options.log;
        this.#registry = options.registry;
        this.#isOpen = options.isOpen;
        this.#connectionKind = options.connectionKind;
        this.#hasBlePeer = options.hasBlePeer;
        this.#write = options.write;
        this.#onChannel = options.onChannel;
        this.#buttonDebounceMs = options.buttonDebounceMs ?? 100;
        this.#pairingTimeoutMs = options.pairingTimeoutMs ?? PAIRING_TIMEOUT_MS;
    }

    /*
     * dongle control
     */

    async pair(endpointId: string, slot: string | number): Promise<void> {
        const { portId, channel } = this.#pairingSlot(endpointId, slot);
        if (this.#pairings.has(endpointId)) {
            throw new HaritoraXError("BUSY", `Pairing is already in progress on ${endpointId}`);
        }

        const completion = this.#pairings.wait(endpointId, this.#pairingTimeoutMs);
        const pairingStartedAt = Date.now();
        const session = { slot: portId, armed: false, wasUnpaired: false };
        this.#pairingSlots.set(endpointId, session);
        this.#log.debug(`Starting pairing on ${endpointId}:${portId}`, {
            channel,
            timeoutMs: this.#pairingTimeoutMs,
        });

        let result: Awaited<typeof completion> | undefined;
        try {
            const [reset, hold] = pairCommands(channel, portId);
            if (reset === undefined || hold === undefined) throw new HaritoraXError("NOT_SUPPORTED", "No pairing commands");

            await this.#write(endpointId, reset);
            await delay(PAIRING_COMMAND_DELAY_MS);

            session.wasUnpaired = this.#isUnpaired(endpointId, portId);
            session.armed = true;
            await this.#write(endpointId, hold);

            result = await completion;
        } catch (error) {
            this.#pairings.cancel(endpointId);
            throw error;
        } finally {
            this.#pairingSlots.delete(endpointId);

            // never leave the dongle in pairing mode, whether or not a tracker paired
            await this.#write(endpointId, setChannelCommand(channel)).catch((error: unknown) => {
                this.#log.warn(`Could not return ${endpointId} to sensing mode`, { error: String(error) });
            });
        }

        if (result === "timeout") {
            this.#log.warn(`Pairing timed out on ${endpointId}:${portId}`, {
                elapsedMs: Date.now() - pairingStartedAt,
                timeoutMs: this.#pairingTimeoutMs,
            });
            throw new HaritoraXError("TIMEOUT", `Pairing on ${endpointId} timed out`);
        }

        if (result !== "paired") {
            throw new HaritoraXError("CONNECTION_FAILED", `Pairing on ${endpointId} was cancelled`);
        }

        await this.#write(endpointId, `r${portId}:`);

        this.#emitter.emit("paired", { endpointId, slot: portId });
        this.#log.info(`Paired ${endpointId}:${portId}`, { elapsedMs: Date.now() - pairingStartedAt, channel });
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

    // round trip to the dongle in ms, from the last `i:` ping
    getLatency(endpointId: string): number | undefined {
        return this.#latencies.get(endpointId);
    }

    async setChannel(endpointId: string, channel: number): Promise<void> {
        if (!isValidChannel(channel)) {
            throw new HaritoraXError("NOT_SUPPORTED", `Channel must be an integer between 1 and 10, got ${channel}`);
        }

        if (!this.#isOpen(endpointId)) {
            throw new HaritoraXError("NOT_CONNECTED", `${endpointId} is not connected`);
        }

        // don't allow setting dupe channels lol
        for (const [otherId, otherChannel] of this.#channels) {
            if (otherId !== endpointId && otherChannel === channel) {
                throw new HaritoraXError("NOT_SUPPORTED", `Channel ${channel} is already used by ${otherId}`);
            }
        }

        await this.#write(endpointId, setChannelCommand(channel));
        this.#updateChannel(endpointId, channel);
    }

    async setSettings(endpointId: string, slot: string, settings: TrackerSettings): Promise<void> {
        if (!this.#isOpen(endpointId)) {
            throw new HaritoraXError("NOT_CONNECTED", `${endpointId} is not connected`);
        }

        const echo = await this.#requireEcho(endpointId, slot);
        await this.#write(endpointId, dongleSettingsCommand(slot, settings, undefined, undefined, echo));

        const device = this.#registry.deviceAt(endpointId, slot);
        if (device) this.#registry.setSettings(device.deviceId, settings);

        this.#log.info(`Applied settings to ${endpointId}:${slot}`);
    }

    async powerOff(endpointId: string, slot: string): Promise<void> {
        if (!this.#isOpen(endpointId)) {
            throw new HaritoraXError("NOT_CONNECTED", `${endpointId} is not connected`);
        }

        const echo = await this.#requireEcho(endpointId, slot);
        const settings = decodeSettings(echo);
        if (!settings) throw new HaritoraXError("NOT_SUPPORTED", `Settings are not available for ${endpointId}:${slot}`);
        const command = dongleSettingsCommand(slot, settings, 2, undefined, echo);
        const restore = dongleSettingsCommand(slot, settings, 0, undefined, echo);
        await this.#write(endpointId, command);
        await delay(this.#commandHoldMs(endpointId, slot));
        await this.#write(endpointId, restore);

        this.#log.info(`Powering off ${endpointId}:${slot}`);
    }

    // swaps to BLE
    async switchCommunication(endpointId: string, slot: string): Promise<void> {
        if (!this.#isOpen(endpointId)) {
            throw new HaritoraXError("NOT_CONNECTED", `${endpointId} is not connected`);
        }

        const echo = await this.#requireEcho(endpointId, slot);
        const settings = decodeSettings(echo);
        if (!settings) throw new HaritoraXError("NOT_SUPPORTED", `Settings are not available for ${endpointId}:${slot}`);
        const command = dongleSettingsCommand(slot, settings, 1, undefined, echo);
        const restore = dongleSettingsCommand(slot, settings, 0, undefined, echo);
        await this.#write(endpointId, command);
        await delay(this.#commandHoldMs(endpointId, slot));
        await this.#write(endpointId, restore);

        this.#log.info(`Switching ${endpointId}:${slot} to BLE`);
    }

    async setBodyPart(endpointId: string, slot: string, bodyPart: BodyPart): Promise<void> {
        if (!this.#isOpen(endpointId)) {
            throw new HaritoraXError("NOT_CONNECTED", `${endpointId} is not connected`);
        }

        const device = this.#registry.deviceAt(endpointId, slot);
        if (!device) throw new HaritoraXError("DEVICE_NOT_FOUND", `No device on ${endpointId}:${slot}`);

        const trackerId = trackerIdOfBodyPart(bodyPart);
        if (trackerId === undefined) {
            throw new HaritoraXError("NOT_SUPPORTED", `"${bodyPart}" can't be assigned to a tracker`);
        }

        const settings = device.settings;
        if (!settings) {
            throw new HaritoraXError("READ_FAILED", `Settings of ${device.deviceId} haven't been received from the dongle yet`);
        }

        const unlock = bodyPartNeedsUnlock(device.model, device.version);
        if (unlock === undefined) {
            throw new HaritoraXError(
                "NOT_SUPPORTED",
                `${device.deviceId} didn't report its firmware version, so its body part can't be set safely`,
            );
        }

        const echo = await this.#requireEcho(endpointId, slot);
        const key = endpointSlotKey(endpointId, slot);
        if (this.#bodyPartWaits.has(key)) {
            throw new HaritoraXError("BUSY", `A body-part change is already in progress on ${endpointId}:${slot}`);
        }
        const wait = this.#createBodyPartWait(key, bodyPart);

        try {
            const commands = bodyPartCommands(slot, settings, trackerId, unlock, echo);
            for (const [index, command] of commands.entries()) {
                if (index > 0) await delay(BODY_PART_STEP_DELAY_MS);
                await this.#write(endpointId, command);
            }

            await this.#write(endpointId, `r${slot}:`);
        } catch (error) {
            this.#finishBodyPartWait(key, wait, undefined);
            throw error;
        }

        const confirmed = await wait.promise;
        if (confirmed === undefined) {
            throw new HaritoraXError("NOT_CONNECTED", `${endpointId}:${slot} disconnected before confirming its body part`);
        }
        if (!confirmed) {
            throw new HaritoraXError(
                "TIMEOUT",
                `${device.deviceId} did not confirm the body part "${bodyPart}", firmware may have rejected it`,
            );
        }

        this.#log.info(`Set body part of ${endpointId}:${slot} to ${bodyPart}`);
    }

    getDongleVersion(endpointId: string): string | undefined {
        return this.#dongleVersions.get(endpointId);
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
        this.#dongleVersions.delete(endpointId);
        this.#pairings.cancel(endpointId);
        this.#pairingSlots.delete(endpointId);
        for (const key of this.#bodyPartWaits.keys()) {
            if (key.startsWith(`${endpointId}:`)) this.#cancelBodyPartWait(key);
        }
        for (const key of this.#settingsReads.keys()) {
            if (key.startsWith(`${endpointId}:`)) {
                this.#settleSettingsRead(key, undefined, new HaritoraXError("NOT_CONNECTED", `${endpointId} disconnected`));
            }
        }

        this.#stopPings(endpointId);
        this.#registers.delete(endpointId);
        this.#latencies.delete(endpointId);
        this.#pingSentAt.delete(endpointId);

        const prefix = `${endpointId}:`;
        for (const key of [...this.#settingsEchoes.keys()]) {
            if (key.startsWith(prefix)) this.#settingsEchoes.delete(key);
        }
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
        for (const key of this.#bodyPartWaits.keys()) this.#cancelBodyPartWait(key);
        for (const key of this.#settingsReads.keys()) {
            this.#settleSettingsRead(key, undefined, new HaritoraXError("NOT_CONNECTED", "Dongle controller disposed"));
        }
        for (const endpointId of [...this.#pingTimers.keys()]) this.#stopPings(endpointId);
        this.#latencies.clear();
        this.#pingSentAt.clear();
        this.#settingsEchoes.clear();
        this.#pairings.cancelAll();
        this.#pairingSlots.clear();
        this.#dongleVersions.clear();
        this.#channels.clear();
        this.#identities.clear();
        this.#buttons.clear();
        this.#lastButtonPress.clear();
    }

    #createBodyPartWait(key: string, bodyPart: BodyPart): BodyPartWait {
        let resolveWait!: (result: boolean | undefined) => void;
        const promise = new Promise<boolean | undefined>((resolve) => (resolveWait = resolve));
        const wait: BodyPartWait = {
            bodyPart,
            timer: setTimeout(() => {
                const current = this.#bodyPartWaits.get(key);
                if (current) this.#finishBodyPartWait(key, current, false);
            }, BODY_PART_TIMEOUT_MS),
            resolve: resolveWait,
            promise,
        };
        this.#bodyPartWaits.set(key, wait);
        return wait;
    }

    #finishBodyPartWait(key: string, wait: BodyPartWait, result: boolean | undefined): void {
        if (this.#bodyPartWaits.get(key) !== wait) return;
        clearTimeout(wait.timer);
        this.#bodyPartWaits.delete(key);
        wait.resolve(result);
    }

    #cancelBodyPartWait(key: string): void {
        const wait = this.#bodyPartWaits.get(key);
        if (wait) this.#finishBodyPartWait(key, wait, undefined);
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

    // how long a power-off / switch-to-BLE command has to stay set, which depends on the tracker's firmware
    #commandHoldMs(endpointId: string, slot: string): number {
        const trackerVersion = this.#registry.deviceAt(endpointId, slot)?.version;
        const dongleVersion = this.#dongleVersions.get(endpointId);

        if (dongleMayDropCommands(trackerVersion, dongleVersion)) {
            this.#log.warn(
                `Tracker firmware ${trackerVersion} needs to see a command in several packets in a row, dongle firmware ${dongleVersion} may not repeat it enough. Update the dongle if the tracker ignores it`,
            );
        }

        return commandHoldMs(trackerVersion);
    }

    #onDongleFrame(endpointId: string, identifier: string, payload: string): void {
        if (identifier === "i") {
            const info = parseInfo(payload);
            if (info?.version) this.#dongleVersions.set(endpointId, info.version);

            this.#onPingReply(endpointId);
            this.#startPings(endpointId);
            return;
        }

        if (identifier === "o") {
            const channel = parseChannel(payload);
            if (channel !== undefined) this.#updateChannel(endpointId, channel);
            return;
        }

        if (identifier === "r") {
            const register = parseDongleRegister(payload);
            if (register) this.#registers.set(endpointId, register);
            this.#tryCompletePairing(endpointId);
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

            if (device.connection === "serial" && this.#hasBlePeer(device.deviceId)) {
                this.#log.debug(`Dongle ${endpointId}:${slot} is searching for ${device.deviceId}, waiting for BLE handoff`);
                return;
            }

            let lost = false;
            for (const imu of device.trackers) {
                lost = this.#registry.markTrackerLost(imu.trackerId, "remote") || lost;
            }

            if (lost) this.#log.warn(`Device ${device.deviceId} lost, dongle ${endpointId}:${slot} is searching`);

            return;
        }

        const decoded = decodeTrackerRssi(payload);
        if (!decoded) return;
        this.#registry.trackerSeen(tracker.trackerId);
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

        this.#registry.register(
            {
                deviceId: serial,
                endpointId,
                slot,
                model,
                firmwareModel: parsed.model,
                version: parsed.version,
                reportedImuCount: parsed.imuCount,
                connection: this.#connectionKind(endpointId),
                parts,
            },
            false,
        );

        const dongleVersion = this.#dongleVersions.get(endpointId);
        if (model === "x2" && imuCount >= 2 && dongleCarriesTwoImus(dongleVersion) === false) {
            this.#log.warn(
                `${serial} has two IMUs, but dongle firmware ${dongleVersion} can't carry them. Update the dongle to 1.0.26 or newer`,
            );
        }
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

        const bodyPartWait = this.#bodyPartWaits.get(key);
        if (bodyPartWait?.bodyPart === bodyPart) this.#finishBodyPartWait(key, bodyPartWait, true);

        if (device) this.#applyAccelAccuracy(endpointId, device, payload);

        // parse and emit button state changes on every `r(x):` frame
        const buttonKey = endpointSlotKey(endpointId, slot);
        const updated = parseDongleButtons(payload, this.#buttons.get(buttonKey));
        this.#buttons.set(buttonKey, updated);

        if (!updated.pressed || !device) return;

        for (const button of updated.pressed) {
            if (!isButtonDebounced(buttonKey, button, this.#lastButtonPress, Date.now(), this.#buttonDebounceMs)) {
                this.#emitter.emit("button", { deviceId: device.deviceId, button });
            }
        }
    }

    #applyAccelAccuracy(endpointId: string, device: DeviceSnapshot, payload: string): void {
        // TODO: test on HXW
        if (device.model !== "x2") return;
        if (dongleReportsAccelAccuracy(this.#dongleVersions.get(endpointId)) === false) return;

        for (const [index, accuracy] of (parseDongleAccelAccuracy(payload) ?? []).entries()) {
            const tracker = device.trackers[index];
            if (tracker) this.#registry.setAccelAccuracy(tracker.trackerId, accuracy);
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

    #isUnpaired(endpointId: string, slot: "0" | "1"): boolean {
        const register = this.#registers.get(endpointId);
        return register !== undefined && isSlotUnpaired(register, slot);
    }

    // pairing completes when the slot goes from "unpaired" to having a stored tracker ID during the attempt. A slot that already has one needs unpairing first
    #tryCompletePairing(endpointId: string): void {
        const session = this.#pairingSlots.get(endpointId);
        if (!session?.armed || !session.wasUnpaired) return;
        if (this.#isUnpaired(endpointId, session.slot) || !this.#registers.has(endpointId)) return;

        if (this.#pairings.settle(endpointId, "paired")) {
            this.#log.info(`Pairing completed on ${endpointId}:${session.slot}`);
        }
    }

    #echo(endpointId: string, slot: string): string | undefined {
        return this.#settingsEchoes.get(endpointSlotKey(endpointId, slot));
    }

    async #requireEcho(endpointId: string, slot: string): Promise<string> {
        const echo = this.#echo(endpointId, slot);
        if (echo && /^[0-9a-f]{14}$/i.test(echo)) return echo;

        const key = endpointSlotKey(endpointId, slot);
        const existing = this.#settingsReads.get(key);
        if (existing) return existing.promise;

        let resolveRead!: (value: string) => void;
        let rejectRead!: (error: Error) => void;
        const promise = new Promise<string>((resolve, reject) => {
            resolveRead = resolve;
            rejectRead = reject;
        });
        const timer = setTimeout(() => {
            this.#settleSettingsRead(
                key,
                undefined,
                new HaritoraXError(
                    "READ_FAILED",
                    `Could not read current settings for ${endpointId}:${slot}, won't apply new settings without a valid echo`,
                ),
            );
        }, SETTINGS_READ_TIMEOUT_MS);
        this.#settingsReads.set(key, { promise, resolve: resolveRead, reject: rejectRead, timer });

        this.#write(endpointId, `o${slot}:`).catch((error: unknown) => {
            this.#settleSettingsRead(
                key,
                undefined,
                new HaritoraXError("READ_FAILED", `Could not request settings for ${endpointId}:${slot}`, { cause: error }),
            );
        });
        return promise;
    }

    #settleSettingsRead(key: string, value: string | undefined, error?: Error): void {
        const read = this.#settingsReads.get(key);
        if (!read) return;
        clearTimeout(read.timer);
        this.#settingsReads.delete(key);
        if (error) read.reject(error);
        else if (value !== undefined) read.resolve(value);
    }

    #onSettingsEcho(key: string, payload: string): void {
        if (!/^[0-9a-f]{14}$/i.test(payload)) return;
        this.#settingsEchoes.set(key, payload);
        this.#settleSettingsRead(key, payload);
    }

    #onSettings(endpointId: string, slot: string, payload: string): void {
        const key = endpointSlotKey(endpointId, slot);
        const first = !this.#settingsEchoes.has(key);
        this.#onSettingsEcho(key, payload);

        // clear leftover power-off / switch to BLE command, so it doesn't keep the tracker off or on BLE after a reconnect
        const settings = decodeSettings(payload);
        if (first && settings && payload.length === 14 && payload.charAt(12) !== "0") {
            this.#write(endpointId, dongleSettingsCommand(slot, settings, 0, undefined, payload)).catch((error: unknown) => {
                this.#log.warn(`Could not clear the leftover command on ${endpointId}:${slot}`, { error: String(error) });
            });
        }

        if (!settings) return;

        const device = this.#registry.deviceAt(endpointId, slot);
        if (!device) return;

        this.#registry.setSettings(device.deviceId, settings);
    }

    #onImu(endpointId: string, slot: string, payload: string): void {
        const input = this.#registry.registrationAt(endpointId, slot);
        if (!input) return; // drop packet if device is unidentified still
        const slices = splitDongleImuBytes(decodeBase64(payload), input.parts.length);
        if (slices.length === 0) return;
        const identity = this.#identities.get(endpointSlotKey(endpointId, slot));
        const device =
            this.#registry.deviceAt(endpointId, slot) ??
            this.#registry.register({
                ...input,
                parts: identity ? bodyPartsFor(identity.bodyPart, input.parts.length) : input.parts,
            });

        for (const slice of slices) {
            this.#emitSample(
                device,
                slice.index,
                slice.role,
                decodeImuBytes(slice.payload, device.model, slice.status, slice.index),
                decodeRange(device.model, slice.range),
            );
        }
    }

    #emitSample(
        device: DeviceSnapshot,
        imuIndex: number,
        role: ImuRole,
        decoded: ReturnType<typeof decodeImuBytes>,
        range: number | undefined,
    ): void {
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
            ...(range === undefined ? {} : { range }),
            timestamp: Date.now(),
        });

        if (decoded.magStatus) this.#registry.setMag(tracker.trackerId, decoded.magStatus);
        if (decoded.tap !== undefined) this.#registry.setTap(tracker.trackerId, decoded.tap);
    }

    #onPingReply(endpointId: string): void {
        const sent = this.#pingSentAt.get(endpointId);
        if (sent === undefined) return;

        this.#pingSentAt.delete(endpointId);
        this.#latencies.set(endpointId, Date.now() - sent);
    }

    #startPings(endpointId: string): void {
        if (this.#pingTimers.has(endpointId)) return;

        const timer = setInterval(() => {
            if (!this.#isOpen(endpointId)) return;

            this.#pingSentAt.set(endpointId, Date.now());
            this.#write(endpointId, "i:").catch((error: unknown) => {
                this.#log.debug(`Latency ping to ${endpointId} failed`, { error: String(error) });
            });
        }, PING_INTERVAL_MS);
        unrefTimerIfSupported(timer);

        this.#pingTimers.set(endpointId, timer);
    }

    #stopPings(endpointId: string): void {
        const timer = this.#pingTimers.get(endpointId);
        if (timer === undefined) return;

        clearInterval(timer);
        this.#pingTimers.delete(endpointId);
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

export function unrefTimerIfSupported(timer: unknown): void {
    const unref = typeof timer === "object" && timer !== null ? (timer as { unref?: unknown }).unref : undefined;
    if (typeof unref === "function") (unref as () => void).call(timer);
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

interface BodyPartWait {
    bodyPart: BodyPart;
    timer: ReturnType<typeof setTimeout>;
    resolve: (result: boolean | undefined) => void;
    promise: Promise<boolean | undefined>;
}

interface SettingsRead {
    promise: Promise<string>;
    resolve: (value: string) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}
