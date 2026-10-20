import { Logger, type LogSink } from "./logging.js";
import { Emitter } from "./emitter.js";
import type { Connection } from "./connections/contract.js";
import type {
    BatteryInfo,
    BodyPart,
    DeviceDescriptor,
    DeviceInfo,
    EventHandler,
    Events,
    ImuRole,
    LogLevel,
    MagStatus,
    TrackerSettings,
    TrackerSnapshot,
    Unsubscribe,
} from "./types.js";

export interface HaritoraXOptions {
    connections?: Connection[];
    logLevel?: LogLevel;
    onLog?: LogSink;
}

export class HaritoraX {
    readonly #emitter = new Emitter();
    readonly #log: Logger;
    readonly #connections: Connection[];
    #disposed = false;

    constructor(options: HaritoraXOptions = {}) {
        this.#connections = options.connections ?? [];
        this.#log = new Logger(
            options.logLevel ?? "info",
            options.onLog ?? ((entry) => console.log(`[${entry.level}] ${entry.message}`)),
        );
        this.#emitter.setErrorHandler((event, error) =>
            this.#log.error(`Listener for "${event}" threw`, { error: String(error) }),
        );
    }

    /*
     * device discovery and connection
     */

    discover(): Promise<void> {
        return this.#todo("discover");
    }

    stopDiscovery(): Promise<void> {
        return this.#todo("stopDiscovery");
    }

    getDevices(): TrackerSnapshot[] {
        return [];
    }

    getDevice(deviceId: string): TrackerSnapshot | undefined {
        return this.getDevices().find((device) => device.deviceId === deviceId);
    }

    connect(_deviceId: string): Promise<void> {
        return this.#todo("connect");
    }

    disconnect(_deviceId: string): Promise<void> {
        return this.#todo("disconnect");
    }

    /*
     * device information and settings
     */

    readInfo(_deviceId: string): Promise<DeviceInfo> {
        return this.#todo("readInfo");
    }

    readBattery(_deviceId: string): Promise<BatteryInfo> {
        return this.#todo("readBattery");
    }

    readMag(_deviceId: string): Promise<MagStatus> {
        return this.#todo("readMag");
    }

    readSettings(_deviceId: string): Promise<TrackerSettings> {
        return this.#todo("readSettings");
    }

    writeSettings(_deviceId: string, _settings: TrackerSettings): Promise<void> {
        return this.#todo("writeSettings");
    }

    powerOff(_deviceId: string): Promise<void> {
        return this.#todo("powerOff");
    }

    assignBodyPart(_deviceId: string, _bodyPart: BodyPart, _role?: ImuRole): void {
        this.#log.error("assignBodyPart() is not implemented yet");
    }

    /*
     * listeners and disposal
     */

    dispose(): Promise<void> {
        if (this.#disposed) return Promise.resolve();
        this.#disposed = true;
        this.#emitter.removeAllListeners();

        const pending = this.#connections.map((connection) =>
            connection.dispose().catch((error: unknown) => {
                this.#log.error(`Connection "${connection.kind}" failed to dispose`, { error: String(error) });
            }),
        );

        return Promise.all(pending).then(() => {
            this.#log.info("Disposed");
        });
    }

    on<E extends keyof Events>(event: E, handler: EventHandler<E>): Unsubscribe {
        return this.#emitter.on(event, handler);
    }

    /*
     * internal stuff
     */

    #todo(method: string): Promise<never> {
        return Promise.reject(new Error(`${method}() is not implemented yet`));
    }
}

export function createHaritoraX(options?: HaritoraXOptions): HaritoraX {
    return new HaritoraX(options);
}

export type { DeviceDescriptor };
