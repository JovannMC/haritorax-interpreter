export interface ProtocolHandler {
    handleFrame(endpointId: string, name: string, slot: string | undefined, payload: string): void;
    forgetEndpoint(endpointId: string): void;
    dispose(): void;
}
