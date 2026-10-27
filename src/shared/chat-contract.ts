import { z } from 'zod';
import { AttachmentIdsSchema, type AttachmentRef } from './attachments';

export interface ChatThread {
  id: string;
  title: string;
  agentId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  threadId: string;
  role: 'user' | 'assistant';
  content: string;
  status: 'complete' | 'streaming' | 'failed' | 'cancelled';
  createdAt: string;
  attachments: AttachmentRef[];
  /** Durable reasoning/tool activity emitted while the assistant produced this reply. */
  activity?: ChatActivity[];
  error?: string;
}

export type ChatActivityStatus = 'neutral' | 'running' | 'completed' | 'failed';

export interface ChatActivity {
  id: string;
  /** Stable provider tool id; start/completion updates share this key. */
  key?: string;
  label: string;
  kind: string;
  detail?: string;
  status: ChatActivityStatus;
  source?: string;
  createdAt: string;
}

export interface ChatConversation {
  thread: ChatThread;
  messages: ChatMessage[];
}

const ChatRunChoice = z.object({
  model: z.string().regex(/^[\w./:@-]{1,100}$/).optional(),
  effort: z.string().regex(/^[a-z]{2,12}$/).optional(),
}).strict();

export const ChatSendRequest = z.object({
  threadId: z.string().uuid().optional(),
  content: z.string().trim().min(1).max(10_000),
  agentId: z.string().trim().regex(/^[\w:.-]{1,200}$/).optional(),
  /** Model and reasoning effort for this reply. Omitted fields mean Auto. */
  runOptions: ChatRunChoice.optional(),
  /** Ids of attachments already ingested by the main process (max 10). */
  attachments: AttachmentIdsSchema.optional(),
}).strict();

export type ChatSendInput = z.infer<typeof ChatSendRequest>;

/** Whether the Mem0 memory service is reachable, for a renderer status badge. */
export interface Mem0Health {
  reachable: boolean;
  /** A human-readable reason when `reachable` is false. */
  detail?: string;
  /** When the check ran (ISO-8601). */
  checkedAt: string;
}

export const CHAT_SCHEMAS = {
  'chat.list': z.void(),
  'chat.get': z.object({ threadId: z.string().uuid() }).strict(),
  'chat.send': ChatSendRequest,
  'chat.cancel': z.object({ threadId: z.string().uuid() }).strict(),
  'chat.delete': z.object({ threadId: z.string().uuid() }).strict(),
  'chat.mem0Health': z.void(),
} as const;

export interface ChatBridge {
  list(): Promise<ChatThread[]>;
  get(threadId: string): Promise<ChatConversation>;
  send(input: ChatSendInput): Promise<ChatConversation>;
  cancel(threadId: string): Promise<void>;
  delete(threadId: string): Promise<void>;
  /** Check whether the Mem0 context service is reachable right now. */
  mem0Health(): Promise<Mem0Health>;
}
