import type { ConnectionErrorEvent, Unsubscribe } from "../types.js";

export class ErrorChannel {
    readonly #handlers = new Set<(event: ConnectionErrorEvent) => void>();
    #reporting = false;

    on(handler: (event: ConnectionErrorEvent) => void): Unsubscribe {
        this.#handlers.add(handler);
        return () => this.#handlers.delete(handler);
    }

    emit(event: ConnectionErrorEvent): void {
        if (this.#reporting) return;
        this.#reporting = true;
        try {
            for (const handler of [...this.#handlers]) {
                try {
                    const result: unknown = handler(event);
                    void Promise.resolve(result).catch(() => undefined);
                } catch {
                    // failed error handler doesn't have a further reporting destination
                }
            }
        } finally {
            this.#reporting = false;
        }
    }

    clear(): void {
        this.#handlers.clear();
    }
}
