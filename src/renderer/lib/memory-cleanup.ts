import { useUiStore } from '../stores/ui-store';

/** Local removal can succeed while Mem0's durable deletion queue is offline. */
export function reportMemoryCleanup(result: unknown): void {
  if (result !== null && typeof result === 'object' && 'memoryCleanupPending' in result && result.memoryCleanupPending === true) {
    useUiStore.getState().setNotice('Removed from Conductor. Mem0 cleanup is queued and will be retried when the memory service is available.');
  }
}
