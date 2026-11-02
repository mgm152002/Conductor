import { z } from 'zod';
import { ATTACHMENT_SCHEMAS } from './attachments';
import { ArtifactImageDataSchema, GeneratedArtifactSpecSchema } from './generated-artifacts';
export const APPLICATION_SCHEMAS = {
  ...ATTACHMENT_SCHEMAS,
  'artifact.generate': z.object({
    spec: GeneratedArtifactSpecSchema,
    images: z.record(z.string().max(64), ArtifactImageDataSchema).optional(),
  }).strict(),
  'artifact.rasterize': z.object({ html: z.string().min(1).max(300_000) }).strict(),
  'workspace.active': z.void(),
  'workspace.changes': z.object({workspaceId:z.string().uuid(),taskId:z.string().uuid().optional()}),
  'workspace.fileDiff': z.object({workspaceId:z.string().uuid(),path:z.string().min(1).max(4096),taskId:z.string().uuid().optional()}),
  'question.list': z.void(),
  'question.answer': z.object({id:z.string().uuid(),answers:z.record(z.string(),z.array(z.string().max(2000)).max(20))}),
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
