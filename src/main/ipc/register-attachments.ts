import { ATTACHMENT_SCHEMAS } from '../../shared/attachments';
import type { AttachmentService } from '../attachments/attachment-service';
import type { IpcRouter } from './router';

// Do not let native-dialog, filesystem or SQLite exception details cross IPC.
async function safe<T>(action: () => T | Promise<T>): Promise<T> {
  try { return await action(); }
  catch { throw new Error('The attachment operation failed. The file may no longer be available.'); }
}

export function registerAttachmentHandlers(router: IpcRouter, attachments: AttachmentService): void {
  router.handle('attachment.pick', ATTACHMENT_SCHEMAS['attachment.pick'], () => safe(() => attachments.pick()));
  router.handle('attachment.ingestPaths', ATTACHMENT_SCHEMAS['attachment.ingestPaths'], (_event, { paths }) => safe(() => attachments.ingest(paths)));
  router.handle('attachment.preview', ATTACHMENT_SCHEMAS['attachment.preview'], (_event, { id }) => safe(() => attachments.preview(id)));
  router.handle('attachment.discard', ATTACHMENT_SCHEMAS['attachment.discard'], (_event, { id }) => safe(() => attachments.discard(id)));
}
