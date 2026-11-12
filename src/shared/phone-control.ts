// Controlling Conductor from a phone: a small web page served from this Mac
// and reached through an ngrok tunnel. The user scans a QR code to open it.

export interface PhoneControlStatus {
  state: 'off' | 'starting' | 'on' | 'error';
  /** The ngrok binary was found on this Mac. */
  ngrokInstalled: boolean;
  /** Public https address of the tunnel, while on. */
  url?: string;
  /** The link the QR code opens: the address plus a one-time pairing code. */
  pairUrl?: string;
  /** The QR code for `pairUrl`, as an SVG data URL. */
  qr?: string;
  /** When the pairing code stops working. */
  pairExpiresAt?: string;
  /** Phones currently signed in. */
  devices: number;
  error?: string;
}
