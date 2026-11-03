// ngl i can only really kinda understand what the ai did here, it apparently is needed to fix bugs that was on v3 so guh
// i'll probably rewrite this or actually try to understand wtf its doing later, but for now it works so i guess its fine
import type { EventHandler, Events, Unsubscribe } from "../types.js";

/**
 * Typed emitter. Two behaviours are load-bearing and are the reason this is not
 * a dependency: on() returns an unsubscribe function, and a throwing handler is
 * reported rather than unwinding through a connection callback.
 */
export class Emitter {
    readonly #handlers = new Map<keyof Events, Set<(payload: never) => void>>();
    #onError: ((event: string, error: unknown) => void | Promise<void>) | undefined;
    #reportingError = false;

    setErrorHandler(handler: (event: string, error: unknown) => void | Promise<void>): void {
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
                const result: unknown = (handler as EventHandler<E>)(payload);
                if (isPromiseLike(result)) {
                    void Promise.resolve(result).catch((error: unknown) => this.#reportError(event, error));
                }
            } catch (error) {
                this.#reportError(event, error);
            }
        }
    }

    #reportError(event: string, error: unknown): void {
        if (this.#reportingError) return;
        this.#reportingError = true;
        let reportingAsync = false;
        try {
            const result = this.#onError?.(event, error);
            if (isPromiseLike(result)) {
                reportingAsync = true;
                void Promise.resolve(result)
                    .catch(() => undefined)
                    .finally(() => {
                        this.#reportingError = false;
                    });
            }
        } catch {
            // Error reporting must not unwind through event dispatch or recurse into itself.
        } finally {
            if (!reportingAsync) this.#reportingError = false;
        }
    }

    removeAllListeners(): void {
        this.#handlers.clear();
    }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
    return (typeof value === "object" && value !== null) || typeof value === "function"
        ? typeof (value as { then?: unknown }).then === "function"
        : false;
}
