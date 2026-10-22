import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { Connector, ConnectorLifecycle, RetrieveResult, RetrievedItem } from '@shared/connector';
import { NetworkAccess } from './network-access';

// IMAP email connector (kind `email`). Works with any IMAP server that accepts
// password login over TLS — e.g. iCloud, Fastmail, or Gmail/Outlook with an
// app password. It is read-only: mailboxes are opened read-only and messages
// are fetched with BODY.PEEK semantics, so nothing is marked as read.
//
// Incremental sync uses a {uidValidity, lastUid} cursor. The first sync reads
// the most recent messages only; later syncs read messages with a higher UID.

export const FIRST_SYNC_MESSAGES = 50;
export const MAX_MESSAGES_PER_SYNC = 100;
export const MAX_MESSAGE_BYTES = 256 * 1024;
export const MAX_BODY_CHARS = 16_000;

export interface ImapCredentials {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

export interface MailboxInfo { uidValidity: string; uidNext: number; exists: number }

export interface FetchedMessage {
  uid: number;
  source?: Buffer;
  internalDate?: Date | string;
}

/** The IMAP surface the connector uses; injected so tests run without a server. */
export interface MailClient {
  connect(): Promise<void>;
  open(mailbox: string): Promise<MailboxInfo>;
  fetch(range: string): AsyncIterable<FetchedMessage>;
  close(): Promise<void>;
}

export type MailClientFactory = (credentials: ImapCredentials) => MailClient;

export const imapClientFactory: MailClientFactory = (credentials) => {
  const client = new ImapFlow({
    host: credentials.host,
    port: credentials.port,
    secure: credentials.secure,
    auth: { user: credentials.user, pass: credentials.pass },
    logger: false,
    socketTimeout: 60_000,
  });
  return {
    connect: () => client.connect(),
    async open(mailbox) {
      const info = await client.mailboxOpen(mailbox, { readOnly: true });
      return { uidValidity: String(info.uidValidity), uidNext: Number(info.uidNext), exists: info.exists };
    },
    async *fetch(range) {
      for await (const message of client.fetch(range, { uid: true, internalDate: true, source: { maxLength: MAX_MESSAGE_BYTES } }, { uid: true })) {
        yield {
          uid: message.uid,
          ...(message.source !== undefined ? { source: message.source } : {}),
          ...(message.internalDate !== undefined ? { internalDate: message.internalDate } : {}),
        };
      }
    },
    async close() {
      try { await client.logout(); } catch { client.close(); }
    },
  };
};

interface EmailCursor { v: 1; uidValidity: string; lastUid: number }

function parseCursor(cursor: string | undefined): EmailCursor | undefined {
  if (cursor === undefined) return undefined;
  try {
    const parsed = JSON.parse(cursor) as Partial<EmailCursor>;
    return parsed.v === 1 && typeof parsed.uidValidity === 'string' && typeof parsed.lastUid === 'number'
      ? { v: 1, uidValidity: parsed.uidValidity, lastUid: parsed.lastUid } : undefined;
  } catch { return undefined; }
}

function emailConfig(connector: Connector | undefined): NonNullable<Connector['config']['email']> {
  const config = connector?.config.email;
  if (config === undefined) throw new Error('This email connector has no account configured.');
  return config;
}

function addresses(value: unknown): string {
  if (value === undefined || value === null) return '';
  const list = Array.isArray(value) ? value : [value];
  return list.map((entry) => (entry as { text?: string }).text ?? '').filter(Boolean).join(', ');
}

/** Render a raw RFC 822 message as readable text for indexing. */
export async function renderMessage(source: Buffer): Promise<{ text: string; subject: string; from: string; to: string; date?: Date; messageId?: string }> {
  const mail = await simpleParser(source, { skipImageLinks: true, skipTextToHtml: true });
  const subject = mail.subject ?? '(no subject)';
  const from = addresses(mail.from);
  const to = addresses(mail.to);
  const body = (mail.text ?? '').replace(/\r\n/g, '\n').trim();
  const clipped = body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}\n… (truncated)` : body;
  const header = [`From: ${from}`, `To: ${to}`, ...(mail.date ? [`Date: ${mail.date.toISOString()}`] : []), `Subject: ${subject}`].join('\n');
  return {
    text: `${header}\n\n${clipped}`, subject, from, to,
    ...(mail.date ? { date: mail.date } : {}),
    ...(mail.messageId ? { messageId: mail.messageId } : {}),
  };
}

export class EmailConnectorLifecycle implements ConnectorLifecycle {
  readonly kind = 'email' as const;

  constructor(private readonly network: NetworkAccess, private readonly clients: MailClientFactory = imapClientFactory) {}

  static provider(host: string): string {
    return `email:${host.toLowerCase()}`;
  }

  private async session<T>(connector: Connector, run: (client: MailClient, mailbox: MailboxInfo) => Promise<T>): Promise<T> {
    const config = emailConfig(connector);
    return this.network.egress(connector, {
      provider: EmailConnectorLifecycle.provider(config.host),
      target: config.host,
      request: { host: config.host, port: config.port, secure: config.secure, user: config.user, pass: NetworkAccess.placeholder(config.secretId) },
    }, async (credentials) => {
      const client = this.clients(credentials);
      await client.connect();
      try {
        const mailbox = await client.open(config.mailbox);
        return await run(client, mailbox);
      } finally {
        await client.close();
      }
    });
  }

  /** Logs in and opens the mailbox read-only. */
  async authorize(connector?: Connector): Promise<void> {
    if (connector === undefined) throw new Error('Connector required');
    await this.session(connector, async () => undefined);
  }

  async retrieve(cursor: string | undefined, connector?: Connector): Promise<RetrieveResult> {
    if (connector === undefined) throw new Error('Connector required');
    const config = emailConfig(connector);
    return this.session(connector, async (client, mailbox) => {
      const previous = parseCursor(cursor);
      const fresh = previous === undefined || previous.uidValidity !== mailbox.uidValidity;
      const lastUid = fresh ? Math.max(0, mailbox.uidNext - 1 - FIRST_SYNC_MESSAGES) : previous.lastUid;
      if (mailbox.exists === 0 || lastUid + 1 >= mailbox.uidNext) {
        return { items: [], nextCursor: JSON.stringify({ v: 1, uidValidity: mailbox.uidValidity, lastUid: Math.max(lastUid, mailbox.uidNext - 1) }) };
      }
      const end = Math.min(mailbox.uidNext - 1, lastUid + MAX_MESSAGES_PER_SYNC);
      const items: RetrievedItem[] = [];
      let maxUid = lastUid;
      for await (const message of client.fetch(`${lastUid + 1}:${end}`)) {
        maxUid = Math.max(maxUid, message.uid);
        if (message.source === undefined) continue;
        const rendered = await renderMessage(message.source);
        const when = rendered.date ?? (message.internalDate !== undefined ? new Date(message.internalDate) : new Date());
        items.push({
          externalId: `${mailbox.uidValidity}:${message.uid}`,
          content: rendered.text,
          sourceTimestamp: when.toISOString(),
          permissions: [`email_read:${config.user}@${config.host}/${config.mailbox}`],
          origin: `Email · ${rendered.subject}`,
        });
      }
      return { items, nextCursor: JSON.stringify({ v: 1, uidValidity: mailbox.uidValidity, lastUid: Math.max(maxUid, end) }) };
    });
  }

  async revoke(): Promise<void> {
    // No server-side session is held between syncs.
  }
}
