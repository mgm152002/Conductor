import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_SCHEMAS,
  AttachmentIdsSchema,
  MAX_ATTACHMENTS_PER_MESSAGE,
  attachmentBatchError,
  attachmentSizeError,
  MAX_ATTACHMENT_BYTES,
} from '../../src/shared/attachments';
import { TaskCreateRequest } from '../../src/shared/ipc-contract';
import { ChatSendRequest } from '../../src/shared/chat-contract';

const ids = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, (_, index) =>
  `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
);

describe('attachment validation boundaries', () => {
  it('accepts the exact count boundary and rejects one extra across IPC schemas', () => {
    expect(AttachmentIdsSchema.safeParse(ids.slice(0, MAX_ATTACHMENTS_PER_MESSAGE)).success).toBe(true);
    expect(AttachmentIdsSchema.safeParse(ids).success).toBe(false);
    expect(ATTACHMENT_SCHEMAS['attachment.ingestPaths'].safeParse({
      paths: ids.slice(0, MAX_ATTACHMENTS_PER_MESSAGE).map((id) => `/tmp/${id}.txt`),
    }).success).toBe(true);
    expect(ATTACHMENT_SCHEMAS['attachment.ingestPaths'].safeParse({ paths: ids.map((id) => `/tmp/${id}.txt`) }).success).toBe(false);
    expect(TaskCreateRequest.safeParse({
      workspaceId: ids[0], objective: 'Review files', attachmentIds: ids,
    }).success).toBe(false);
    expect(ChatSendRequest.safeParse({ content: 'Review files', attachments: ids }).success).toBe(false);
  });

  it('rejects malformed ids, arbitrary preview paths, empty files and oversized bytes', () => {
    expect(AttachmentIdsSchema.safeParse(['../../secret']).success).toBe(false);
    expect(ATTACHMENT_SCHEMAS['attachment.preview'].safeParse({ id: ids[0], path: '/etc/passwd' }).success).toBe(false);
    expect(attachmentSizeError(0)).toMatch(/empty/i);
    expect(attachmentSizeError(MAX_ATTACHMENT_BYTES)).toBeNull();
    expect(attachmentSizeError(MAX_ATTACHMENT_BYTES + 1)).toMatch(/larger/i);
    expect(attachmentBatchError(MAX_ATTACHMENTS_PER_MESSAGE + 1)).toMatch(/at most/i);
  });
});
