import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/**
 * A stand-in for Chrome's DevTools endpoint: a bare WebSocket server that answers
 * every command, and (like Chrome's chrome://inspect remote debugging) serves no
 * HTTP discovery endpoints such as /json/version.
 */
export interface FakeCdp { port: number; path: string; methods: string[]; close: () => Promise<void> }

const answers: Record<string, Record<string, unknown>> = {
  'Target.createTarget': { targetId: 'target-1' },
  'Target.attachToTarget': { sessionId: 'session-1' },
  'Page.captureScreenshot': { data: 'cG5n' },
  'Browser.getVersion': { userAgent: 'Mozilla/5.0 Chrome/159.0.0.0' },
};

function frame(text: string): Buffer {
  const body = Buffer.from(text);
  if (body.length > 0xffff) throw new Error('fake-cdp: frame too large');
  const head = body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.from([0x81, 126, body.length >> 8, body.length & 0xff]);
  return Buffer.concat([head, body]);
}

/** Decode the masked client text frames in `data` (enough for small test messages). */
function messages(data: Buffer): string[] {
  const out: string[] = [];
  let at = 0;
  while (at + 2 <= data.length) {
    let length = data[at + 1]! & 0x7f;
    let offset = at + 2;
    if (length === 126) { length = data.readUInt16BE(offset); offset += 2; }
    const mask = data.subarray(offset, offset + 4);
    offset += 4;
    const body = Buffer.from(data.subarray(offset, offset + length));
    for (let i = 0; i < body.length; i += 1) body[i]! ^= mask[i % 4]!;
    if ((data[at]! & 0x0f) === 0x1) out.push(body.toString('utf8'));
    at = offset + length;
  }
  return out;
}

/**
 * `discovery`: also serve /json/version, as a Chrome started with --remote-debugging-port does.
 * `answer`: the result for a command (falls back to the canned answers).
 */
export async function fakeCdp(opts: { discovery?: boolean; answer?: (method: string, params: Record<string, unknown>) => Record<string, unknown> | undefined } = {}): Promise<FakeCdp> {
  const methods: string[] = [];
  const sockets = new Set<Socket>();
  const path = '/devtools/browser/fake';
  const server: Server = createServer((req, res) => {
    if (opts.discovery === true && req.url === '/json/version') { res.setHeader('content-type', 'application/json'); res.end('{"Browser":"Chrome/159"}'); return; }
    res.statusCode = 404;
    res.end();
  });
  server.on('upgrade', (req, socket: Socket) => {
    sockets.add(socket);
    const accept = createHash('sha1').update(`${String(req.headers['sec-websocket-key'])}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('data', (data: Buffer) => {
      for (const text of messages(data)) {
        const { id, method, params } = JSON.parse(text) as { id: number; method: string; params?: Record<string, unknown> };
        methods.push(method);
        socket.write(frame(JSON.stringify({ id, result: opts.answer?.(method, params ?? {}) ?? answers[method] ?? {} })));
      }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  return {
    port: (server.address() as AddressInfo).port, path, methods,
    close: () => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); server.close(() => { resolve(); }); }),
  };
}
