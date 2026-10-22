import type { Connector } from '@shared/connector';
import { secretToken } from '@shared/secrets';
import type { SecretsProxy } from '../secrets/secrets-proxy';

// Every network connector goes through two gates before touching a remote
// service:
//  1. consent — the user must have allowed the provider in data control (the
//     external-flow indicator fires for each permitted flow);
//  2. the SecretsProxy — credentials are written into the request only at
//     egress, from the Keychain, and only for the connector that owns them.

export interface ConsentGate {
  /** Throws when the user has not consented to this provider. */
  require(provider: string, target: string): void;
}

export class NetworkAccess {
  constructor(private readonly proxy: SecretsProxy, private readonly consent: ConsentGate) {}

  /** The caller identity the SecretsProxy gate checks secret ownership against. */
  static subject(connector: Pick<Connector, 'id'>): string {
    return `connector:${connector.id}`;
  }

  /** `{{SECRET:id}}` placeholder for a stored secret. */
  static placeholder(secretId: string): string {
    return secretToken(secretId);
  }

  /**
   * Check consent, then run `send` with the request's placeholders replaced by
   * real secret values. `request` is what gets audited (placeholder form).
   */
  async egress<TRequest, TResult>(
    connector: Pick<Connector, 'id'>,
    input: { provider: string; target: string; request: TRequest },
    send: (resolved: TRequest) => Promise<TResult>,
  ): Promise<TResult> {
    this.consent.require(input.provider, input.target);
    return await this.proxy.egressRequest(
      { request: input.request, adapterId: NetworkAccess.subject(connector), target: input.target },
      (resolved) => send(resolved as TRequest),
    ) as TResult;
  }
}
