import type { WebContents } from 'electron';
import type { IpcRouter } from './router';
import type {
  TaskEventChannel,
  TaskEventEmitter,
} from '../orchestrator/event-emitter';

// The production {@link TaskEventEmitter}: relays the orchestrator's RUNNING
// execution events (`task.updated`, `task.stream`) to the renderer through the
// IPC router, which redacts every payload before it leaves the main process.
//
// The orchestrator is composed at bootstrap, before the BrowserWindow exists,
// so this emitter resolves the target `WebContents` lazily through a settable
// resolver (mirroring the theme relay's `getWebContents` seam). `index.ts`
// installs the resolver once the window is created; until then — and after the
// window is destroyed — emits are silently dropped so execution never depends
// on a live renderer and an emit can never throw back into the execution loop.

export class IpcTaskEventEmitter implements TaskEventEmitter {
  private getWebContents: () => WebContents | null = () => null;

  constructor(private readonly router: IpcRouter) {}

  /** Install the resolver that locates the live renderer target. */
  setWebContentsResolver(resolver: () => WebContents | null): void {
    this.getWebContents = resolver;
  }

  emit(channel: TaskEventChannel, payload: unknown): void {
    const target = this.getWebContents();
    if (target === null || target.isDestroyed()) {
      return;
    }
    try {
      this.router.emit(target, channel, payload);
    } catch {
      // A failed transport must never fail a step; drop the emit.
    }
  }
}
