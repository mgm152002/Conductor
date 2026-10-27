import { z } from 'zod';
import { ATTACHMENT_SCHEMAS } from './attachments';
export const APPLICATION_SCHEMAS = {
  ...ATTACHMENT_SCHEMAS,
  'workspace.active': z.void(),
  'workspace.changes': z.object({workspaceId:z.string().uuid()}),
  'workspace.fileDiff': z.object({workspaceId:z.string().uuid(),path:z.string().min(1).max(4096)}),
  'task.list': z.object({workspaceId:z.string().uuid().optional(),limit:z.number().int().min(1).max(500).optional()}).optional(),
  'task.details': z.object({id:z.string().uuid()}),
  'task.readArtifact': z.object({taskId:z.string().uuid(),artifactId:z.string().uuid()}),
  'task.retry': z.object({id:z.string().uuid()}),
  'task.thread': z.object({threadId:z.string().uuid()}),
  'approval.list': z.void(),
  'permission.getProfile': z.void(),
  'permission.setProfile': z.object({profile:z.enum(['read_only','assisted_execution','trusted_automation'])}),
  'audit.list': z.object({limit:z.number().int().min(1).max(500).optional()}).optional(),
} as const;
