import type { WebContents } from 'electron';
import type { IpcRouter } from './router';
import type { ExternalFlowIndicator } from '@shared/domain';
import type { ExternalFlowEmitter } from '../orchestrator/external-flow-emitter';

// The production {@link ExternalFlowEmitter}: relays the data-control service's
// external-flow indicator to the renderer through the IPC router over the
// allowlisted `dataflow.external` channel, which redacts the payload before it
// leaves the main process (Requirement 21.1).
//
// The service is composed at bootstrap, before the BrowserWindow exists, so
// this emitter resolves the target `WebContents` lazily through a settable
// resolver (mirroring the task-event emitter and theme relay). `index.ts`
// installs the resolver once the window is created; until then — and after the
// window is destroyed — emits are silently dropped so a flow decision never
// depends on a live renderer and an emit can never throw back into the caller.

export class IpcExternalFlowEmitter implements ExternalFlowEmitter {
  private getWebContents: () => WebContents | null = () => null;

  constructor(private readonly router: IpcRouter) {}

  /** Install the resolver that locates the live renderer target. */
  setWebContentsResolver(resolver: () => WebContents | null): void {
    this.getWebContents = resolver;
  }

  emit(indicator: ExternalFlowIndicator): void {
    const target = this.getWebContents();
    if (target === null || target.isDestroyed()) {
      return;
    }
    try {
      this.router.emit(target, 'dataflow.external', indicator);
    } catch {
      // A failed transport must never fail a flow decision; drop the emit.
    }
  }
}
