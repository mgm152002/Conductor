import qrcode from 'qrcode-generator';
import type { PhoneControlStatus } from '@shared/phone-control';
import { PhoneServer, type PhoneServerDeps } from './phone-server';
import { findNgrok, startTunnel, type Tunnel } from './ngrok-tunnel';

// "Control on phone": a web server on loopback plus an ngrok tunnel to it,
// started only when the user asks and stopped when they turn it off or quit.
// The QR code carries a one-time pairing link; everything else needs the
// session that link creates.

export interface PhoneControlOptions extends PhoneServerDeps {
  /** Overridable for tests. */
  ngrokPath?: () => string | undefined;
  tunnel?: typeof startTunnel;
}

export function qrDataUrl(text: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const svg = qr.createSvgTag({ cellSize: 6, margin: 3, scalable: true });
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

export class PhoneControl {
  private server: PhoneServer | undefined;
  private tunnel: Tunnel | undefined;
  private current: PhoneControlStatus;
  private starting: Promise<PhoneControlStatus> | undefined;
  private readonly ngrokPath: () => string | undefined;
  private readonly openTunnel: typeof startTunnel;
  private publicUrl: string | undefined;

  constructor(private readonly options: PhoneControlOptions) {
    this.ngrokPath = options.ngrokPath ?? findNgrok;
    this.openTunnel = options.tunnel ?? startTunnel;
    this.current = { state: 'off', ngrokInstalled: this.ngrokPath() !== undefined, devices: 0 };
  }

  status(): PhoneControlStatus {
    return { ...this.current, ngrokInstalled: this.ngrokPath() !== undefined, devices: this.server?.devices ?? 0 };
  }

  start(): Promise<PhoneControlStatus> {
    if (this.current.state === 'on') return Promise.resolve(this.refreshPairing());
    this.starting ??= this.boot().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  /** A new QR code (the old one stops working). */
  refreshPairing(): PhoneControlStatus {
    if (this.server === undefined || this.publicUrl === undefined) return this.status();
    const { code, expiresAt } = this.server.newPairing();
    const pairUrl = `${this.publicUrl}/#pair=${code}`;
    this.current = { ...this.current, state: 'on', url: this.publicUrl, pairUrl, qr: qrDataUrl(pairUrl), pairExpiresAt: new Date(expiresAt).toISOString() };
    delete this.current.error;
    return this.status();
  }

  signOutAll(): PhoneControlStatus { this.server?.revokeAll(); return this.status(); }

  async stop(): Promise<PhoneControlStatus> {
    const tunnel = this.tunnel; const server = this.server;
    this.tunnel = undefined; this.server = undefined; this.publicUrl = undefined;
    tunnel?.stop();
    await server?.close();
    this.current = { state: 'off', ngrokInstalled: this.ngrokPath() !== undefined, devices: 0 };
    return this.status();
  }

  private async boot(): Promise<PhoneControlStatus> {
    const binary = this.ngrokPath();
    if (binary === undefined) {
      this.current = { state: 'error', ngrokInstalled: false, devices: 0, error: 'ngrok isn’t installed. Run “brew install ngrok” in Terminal, add your token with “ngrok config add-authtoken <token>”, then try again.' };
      return this.status();
    }
    this.current = { state: 'starting', ngrokInstalled: true, devices: 0 };
    const server = new PhoneServer(this.options);
    try {
      const port = await server.listen();
      this.server = server;
      const tunnel = await this.openTunnel(binary, port, (reason) => {
        // The tunnel dropped: shut the server too, so nothing stays half-open.
        void this.stop().then(() => { this.current = { state: 'error', ngrokInstalled: true, devices: 0, error: reason }; });
      });
      this.tunnel = tunnel;
      this.publicUrl = tunnel.url;
      return this.refreshPairing();
    } catch (error) {
      await this.stop();
      this.current = { state: 'error', ngrokInstalled: true, devices: 0, error: error instanceof Error ? error.message : String(error) };
      return this.status();
    }
  }
}
