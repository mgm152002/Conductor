import { z } from 'zod';
import type { ConnectorView, IngestedItemView } from './connector';

// Validated IPC surface for connectors (Requirement 14) and the native folder
// picker used by connector and project creation. Schemas stay in the main
// process; the sandboxed preload imports only the `ConnectorBridge` type.

const id = z.string().uuid();
const absolutePath = z.string().trim().min(1).max(4096)
  .refine((value) => value.startsWith('/'), { message: 'Choose an absolute folder path' });

export const CONNECTOR_SCHEMAS = {
  'connector.list': z.void(),
  'connector.createFolder': z.object({
    name: z.string().trim().min(1).max(255),
    rootPath: absolutePath,
    workspaceId: id.optional(),
  }),
  'connector.createEmail': z.object({
    name: z.string().trim().min(1).max(255),
    host: z.string().trim().min(1).max(255),
    port: z.number().int().min(1).max(65535),
    secure: z.boolean(),
    user: z.string().trim().min(1).max(320),
    password: z.string().min(1).max(4096),
    mailbox: z.string().trim().max(255).optional(),
    workspaceId: id.optional(),
  }),
  'connector.createCalendar': z.object({
    name: z.string().trim().min(1).max(255),
    url: z.string().trim().min(1).max(4096),
    workspaceId: id.optional(),
  }),
  'connector.createSlack': z.object({
    name: z.string().trim().min(1).max(255),
    token: z.string().trim().min(1).max(512),
    channels: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
    workspaceId: id.optional(),
  }),
  'connector.authorize': z.object({ id }),
  'connector.sync': z.object({ id, full: z.boolean().optional() }),
  'connector.revoke': z.object({ id }),
  'connector.delete': z.object({ id }),
  'connector.items': z.object({ id, limit: z.number().int().min(1).max(1000).optional() }),
  'system.pickDirectory': z.object({ title: z.string().max(200).optional() }).optional(),
} as const;

export type ConnectorRequest<C extends keyof typeof CONNECTOR_SCHEMAS> = z.infer<(typeof CONNECTOR_SCHEMAS)[C]>;

export interface ConnectorSyncResult {
  connector: ConnectorView;
  succeeded: boolean;
  ingestedCount: number;
  error?: string;
}

export interface ConnectorDeletion {
  id: string;
  removedItems: number;
  removedMemories: number;
  /** Local deletion succeeded; remote Mem0 cleanup is queued for retry. */
  memoryCleanupPending?: boolean;
}

/** Payload of the `connector.updated` event channel. */
export type ConnectorEvent = ConnectorView | { id: string; deleted: true };

/** Type-only import in the sandboxed preload. */
export interface ConnectorBridge {
  list(): Promise<ConnectorView[]>;
  createFolder(input: ConnectorRequest<'connector.createFolder'>): Promise<ConnectorView>;
  createEmail(input: ConnectorRequest<'connector.createEmail'>): Promise<ConnectorView>;
  createCalendar(input: ConnectorRequest<'connector.createCalendar'>): Promise<ConnectorView>;
  createSlack(input: ConnectorRequest<'connector.createSlack'>): Promise<ConnectorView>;
  authorize(id: string): Promise<ConnectorView>;
  sync(input: ConnectorRequest<'connector.sync'>): Promise<ConnectorSyncResult>;
  revoke(id: string): Promise<ConnectorView>;
  delete(id: string): Promise<ConnectorDeletion>;
  items(input: ConnectorRequest<'connector.items'>): Promise<IngestedItemView[]>;
}

export interface SystemBridge {
  /** Native folder picker. Resolves null when the user cancels. */
  pickDirectory(input?: { title?: string }): Promise<string | null>;
}
