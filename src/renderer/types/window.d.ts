// Ambient declaration of the one bridge the sandboxed renderer can reach.
// The preload script exposes `window.conductor` via `contextBridge`; its shape
// is the `ConductorBridge` type derived from the preload's frozen surface.
import type { ConductorBridge } from '../../preload/index';

declare global {
  interface Window {
    readonly conductor: ConductorBridge;
  }
}

export {};
