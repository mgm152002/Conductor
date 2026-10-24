import { useEffect, useState } from 'react';
import type { Mem0Health } from '@shared/chat-contract';

// Polls the Mem0 context service so chat can show when remembered context is
// unavailable. The main process owns the probe (short timeout); the renderer
// only reflects its answer. `null` means the first check has not returned yet.

const POLL_MS = 30_000;

export function useMem0Health(): Mem0Health | null {
  const [health, setHealth] = useState<Mem0Health | null>(null);
  useEffect(() => {
    let active = true;
    const check = (): void => {
      void window.conductor.chat.mem0Health()
        .then((result) => { if (active) setHealth(result); })
        .catch(() => {
          if (active) setHealth({ reachable: false, detail: 'Could not reach the memory service.', checkedAt: new Date().toISOString() });
        });
    };
    check();
    const timer = window.setInterval(check, POLL_MS);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  return health;
}
