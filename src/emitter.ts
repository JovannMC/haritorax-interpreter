// ngl i can only really kinda understand what the ai did here, it apparently is needed to fix bugs that was on v3 so guh
// i'll probably rewrite this or actually try to understand wtf its doing later, but for now it works so i guess its fine
import type { EventHandler, Events, Unsubscribe } from "./types.js";

/**
 * Typed emitter. Two behaviours are load-bearing and are the reason this is not
 * a dependency: on() returns an unsubscribe function, and a throwing handler is
 * reported rather than unwinding through a connection callback.
 */
export class Emitter {
    readonly #handlers = new Map<keyof Events, Set<(payload: never) => void>>();
    #onError: ((event: string, error: unknown) => void) | undefined;

    setErrorHandler(handler: (event: string, error: unknown) => void): void {
        this.#onError = handler;
    }

    on<E extends keyof Events>(event: E, handler: EventHandler<E>): Unsubscribe {
        let set = this.#handlers.get(event);
        if (!set) {
            set = new Set();
            this.#handlers.set(event, set);
        }
        set.add(handler);

        return () => {
            const current = this.#handlers.get(event);
            if (!current) return;
            current.delete(handler);
            if (current.size === 0) this.#handlers.delete(event);
        };
    }

    emit<E extends keyof Events>(event: E, payload: Events[E]): void {
        const set = this.#handlers.get(event);
        if (!set) return;

        for (const handler of [...set]) {
            try {
                (handler as EventHandler<E>)(payload);
            } catch (error) {
                this.#onError?.(event, error);
            }
        }
    }

    removeAllListeners(): void {
        this.#handlers.clear();
    }
}
