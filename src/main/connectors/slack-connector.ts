import type { Connector, ConnectorLifecycle, RetrieveResult, RetrievedItem } from '@shared/connector';
import { NetworkAccess } from './network-access';

// Slack messaging connector (kind `messaging`). Uses a Slack user or bot token
// (xoxp-/xoxb-) with read scopes (channels:history, groups:history,
// im:history, channels:read, groups:read, users:read). Only conversations the
// token's user is a member of are read. The token stays in the Keychain and is
// placed in the Authorization header only at egress.
//
// Cursor: the latest message timestamp seen per conversation.

const API = 'https://slack.com/api/';
export const FIRST_SYNC_DAYS = 7;
export const MAX_CONVERSATIONS = 30;
export const MAX_MESSAGES_PER_CONVERSATION = 100;

export type SlackCall = (method: string, params: Record<string, string>, token: string) => Promise<Record<string, unknown>>;

export const slackHttpCall: SlackCall = async (method, params, token) => {
  if (!/^[a-z.]+$/i.test(method)) throw new Error('Invalid Slack method');
  const url = new URL(method, API);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, 30_000);
  try {
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
    if (response.status === 429) throw new Error(`Slack rate limit reached; retry after ${response.headers.get('retry-after') ?? 'a while'}s`);
    const body = await response.json() as Record<string, unknown>;
    if (body['ok'] !== true) throw new Error(`Slack ${method} failed: ${String(body['error'] ?? response.status)}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
};

interface SlackChannel { id: string; name?: string; is_member?: boolean; is_im?: boolean; user?: string }
interface SlackMessage { ts: string; text?: string; user?: string; bot_id?: string; subtype?: string; thread_ts?: string }

function parseCursor(cursor: string | undefined): Record<string, string> {
  if (cursor === undefined) return {};
  try {
    const parsed = JSON.parse(cursor) as unknown;
    return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, string> : {};
  } catch { return {}; }
}

export class SlackConnectorLifecycle implements ConnectorLifecycle {
  readonly kind = 'messaging' as const;
  static readonly provider = 'slack';

  constructor(private readonly network: NetworkAccess, private readonly call: SlackCall = slackHttpCall, private readonly now: () => number = Date.now) {}

  private session<T>(connector: Connector, run: (call: (method: string, params?: Record<string, string>) => Promise<Record<string, unknown>>) => Promise<T>): Promise<T> {
    const config = connector.config.messaging;
    if (config === undefined) throw new Error('This messaging connector has no Slack token configured.');
    return this.network.egress(connector, {
      provider: SlackConnectorLifecycle.provider,
      target: 'slack.com',
      request: { token: NetworkAccess.placeholder(config.secretId) },
    }, ({ token }) => run((method, params = {}) => this.call(method, params, token)));
  }

  async authorize(connector?: Connector): Promise<void> {
    if (connector === undefined) throw new Error('Connector required');
    await this.session(connector, async (call) => { await call('auth.test'); });
  }

  async retrieve(cursor: string | undefined, connector?: Connector): Promise<RetrieveResult> {
    if (connector === undefined) throw new Error('Connector required');
    const seen = parseCursor(cursor);
    const wanted = new Set(connector.config.messaging?.channels ?? []);
    return this.session(connector, async (call) => {
      const users = new Map<string, string>();
      try {
        const list = await call('users.list', { limit: '500' });
        for (const member of (list['members'] as { id: string; real_name?: string; name?: string }[] | undefined) ?? []) {
          users.set(member.id, member.real_name || member.name || member.id);
        }
      } catch { /* users:read scope is optional; fall back to ids */ }

      const conversations = await call('conversations.list', { types: 'public_channel,private_channel,im', exclude_archived: 'true', limit: '200' });
      const channels = ((conversations['channels'] as SlackChannel[] | undefined) ?? [])
        .filter((channel) => (channel.is_im === true || channel.is_member === true) && (wanted.size === 0 || wanted.has(channel.name ?? '') || wanted.has(channel.id)))
        .slice(0, MAX_CONVERSATIONS);

      const items: RetrievedItem[] = [];
      const next: Record<string, string> = { ...seen };
      const firstOldest = String((this.now() - FIRST_SYNC_DAYS * 86_400_000) / 1000);
      for (const channel of channels) {
        const label = channel.is_im ? `DM with ${users.get(channel.user ?? '') ?? channel.user ?? 'user'}` : `#${channel.name ?? channel.id}`;
        const history = await call('conversations.history', { channel: channel.id, oldest: seen[channel.id] ?? firstOldest, limit: String(MAX_MESSAGES_PER_CONVERSATION), inclusive: 'false' });
        const messages = ((history['messages'] as SlackMessage[] | undefined) ?? []).filter((m) => m.subtype === undefined || m.subtype === 'thread_broadcast');
        for (const message of messages) {
          if (!message.text?.trim()) continue;
          const author = users.get(message.user ?? '') ?? message.user ?? (message.bot_id ? 'bot' : 'unknown');
          const when = new Date(Number(message.ts) * 1000);
          items.push({
            externalId: `${channel.id}:${message.ts}`,
            content: `Slack ${label}\nFrom: ${author}\nAt: ${when.toISOString()}\n\n${message.text.slice(0, 8000)}`,
            sourceTimestamp: when.toISOString(),
            permissions: [`slack_read:${channel.id}`],
            origin: `Slack · ${label}`,
          });
          if (Number(message.ts) > Number(next[channel.id] ?? '0')) next[channel.id] = message.ts;
        }
      }
      return { items, nextCursor: JSON.stringify(next) };
    });
  }

  async revoke(): Promise<void> {}
}
