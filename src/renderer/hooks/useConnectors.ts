import { useCallback, useEffect, useState } from 'react';
import type { ConnectorView } from '@shared/connector';
import type { ConnectorEvent } from '@shared/connector-contract';

/** Live list of connectors, kept current through the `connector.updated` event. */
export function useConnectors(): {
  connectors: ConnectorView[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const [connectors, setConnectors] = useState<ConnectorView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setConnectors(await window.conductor.connectors.list());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load connectors');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return window.conductor.on('connector.updated', (payload) => {
      const event = payload as ConnectorEvent;
      if (event === null || typeof event !== 'object' || typeof event.id !== 'string') return;
      setConnectors((current) => {
        if ('deleted' in event) return current.filter((item) => item.id !== event.id);
        const index = current.findIndex((item) => item.id === event.id);
        if (index === -1) return [...current, event];
        const next = current.slice();
        next[index] = event;
        return next;
      });
    });
  }, [refresh]);

  return { connectors, loading, error, refresh };
}
