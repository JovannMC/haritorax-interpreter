import type { Emitter } from "../lib/emitter.js";
import type { Logger } from "../lib/logging.js";
import type { DeviceRegistry } from "./device-registry.js";
import type { ProtocolHandler } from "./protocol-handler.js";
import { decodeImu } from "../protocol/imu.js";
import { modelFromFirmware, parseBattery, parseInfo, type ParsedInfo } from "../protocol/messages.js";
import {
    parseWiredButton,
    parseWiredState,
    splitWiredImu,
    wiredAnkleEnabled,
    wiredSettingsCommands,
    type WiredState,
} from "../protocol/wired.js";
import type { ConnectionKind, TrackerSettings } from "../types.js";

const WIRED_SLOT = "0";

export interface WiredControllerOptions {
    emitter: Emitter;
    log: Logger;
    registry: DeviceRegistry;
    connectionKind: (endpointId: string) => ConnectionKind;
    write: (endpointId: string, command: string) => Promise<void>;
}

export class WiredController implements ProtocolHandler {
    readonly #emitter: Emitter;
    readonly #log: Logger;
    readonly #registry: DeviceRegistry;
    readonly #connectionKind: (endpointId: string) => ConnectionKind;
    readonly #write: (endpointId: string, command: string) => Promise<void>;
    readonly #states = new Map<string, WiredState>();
    readonly #infos = new Map<string, ParsedInfo>();

    constructor(options: WiredControllerOptions) {
        this.#emitter = options.emitter;
        this.#log = options.log;
        this.#registry = options.registry;
        this.#connectionKind = options.connectionKind;
        this.#write = options.write;
    }

    handleFrame(endpointId: string, name: string, slot: string | undefined, payload: string): void {
        if (slot) return;

        // i still hate how IMU data used so many different identifiers, that made me go crazy back then i remember
        switch (name) {
            case "i":
                this.#onInfo(endpointId, payload);
                break;
            case "s":
                this.#onState(endpointId, payload);
                break;
            case "v":
                this.#onBattery(endpointId, payload);
                break;
            case "t":
                this.#onButton(endpointId, payload);
                break;
            case "x":
            case "p":
            case "r":
            case "e":
            case "h":
            case "g":
                this.#onImu(endpointId, name, payload);
                break;
        }
    }

    forgetEndpoint(endpointId: string): void {
        this.#states.delete(endpointId);
        this.#infos.delete(endpointId);
    }

    dispose(): void {
        this.#states.clear();
        this.#infos.clear();
    }

    async setSettings(endpointIds: readonly string[], settings: TrackerSettings): Promise<void> {
        const commands = wiredSettingsCommands(settings);

        for (const endpointId of endpointIds) {
            for (const command of commands) await this.#write(endpointId, command);
        }

        for (const device of this.#registry.listDevices()) {
            if (device.model === "wired") this.#registry.setSettings(device.deviceId, settings);
        }

        this.#log.info(`Applied wired settings to ${endpointIds.length} endpoint(s)`);
    }

    #onInfo(endpointId: string, payload: string): void {
        const info = parseInfo(payload);
        if (!info || !info.serialNumber) return;

        this.#infos.set(endpointId, info);

        const state = this.#states.get(endpointId);
        if (state) this.#register(endpointId, info, state);
    }

    #onState(endpointId: string, payload: string): void {
        const state = parseWiredState(payload);
        if (!state) {
            this.#log.debug(`Ignored wired state from ${endpointId}`, { payload });
            return;
        }

        this.#states.set(endpointId, state);

        const device = this.#registry.deviceAt(endpointId, WIRED_SLOT);
        if (device) {
            this.#registry.setTrackers(device.deviceId, state.parts);
            this.#applyMag(device.deviceId, state);
            return;
        }

        const info = this.#infos.get(endpointId);
        if (info) this.#register(endpointId, info, state);
    }

    #register(endpointId: string, info: ParsedInfo, state: WiredState): void {
        const device = this.#registry.register({
            deviceId: info.serialNumber,
            endpointId,
            slot: WIRED_SLOT,
            model: modelFromFirmware(info.model),
            firmwareModel: info.model,
            version: info.version,
            reportedImuCount: info.imuCount,
            connection: this.#connectionKind(endpointId),
            parts: state.parts,
        });

        this.#applyMag(device.deviceId, state);
    }

    #onBattery(endpointId: string, payload: string): void {
        const parsed = parseBattery(payload);
        if (!parsed) return;

        const device = this.#registry.deviceAt(endpointId, WIRED_SLOT);
        if (!device) return;

        this.#registry.setBattery(device.deviceId, {
            deviceId: device.deviceId,
            level: parsed.level,
            voltage: parsed.voltage,
            chargeStatus: parsed.chargeStatus,
            timestamp: Date.now(),
        });
    }

    #onButton(endpointId: string, payload: string): void {
        const button = parseWiredButton(payload);
        if (!button) return;

        const device = this.#registry.deviceAt(endpointId, WIRED_SLOT);
        if (!device) return;

        this.#emitter.emit("button", { deviceId: device.deviceId, button });
    }

    #onImu(endpointId: string, identifier: string, payload: string): void {
        const device = this.#registry.deviceAt(endpointId, WIRED_SLOT);
        if (!device || device.trackers.length === 0) return;

        const slices = splitWiredImu(payload, device.trackers.length, wiredAnkleEnabled(identifier));
        for (const slice of slices) {
            const tracker = device.trackers[slice.index];
            if (!tracker) continue;

            const decoded = decodeImu(slice.payload, device.model);
            if (!decoded || !this.#registry.trackerSeen(tracker.trackerId)) continue;

            const ankleAngle = decoded.ankleAngle ?? slice.ankleAngle;

            this.#emitter.emit("imu", {
                trackerId: tracker.trackerId,
                deviceId: device.deviceId,
                bodyPart: tracker.bodyPart,
                role: "single",
                rotation: decoded.rotation,
                acceleration: decoded.acceleration,
                ...(ankleAngle === undefined ? {} : { ankleAngle }),
                timestamp: Date.now(),
            });
        }
    }

    #applyMag(deviceId: string, state: WiredState): void {
        for (const [i, status] of state.magStatuses.entries()) {
            if (status === undefined) continue;
            this.#registry.setMag(`${deviceId}:${i}`, status);
        }
    }
}
