import type { TaskEvent } from '@shared/domain';

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function eventText(event: TaskEvent): string {
  const payload = record(event.payload);
  const value = event.kind === 'stream' && payload !== null ? payload['data'] : event.payload;
  if (typeof value === 'string') return value;
  const object = record(value);
  if (object !== null) {
    for (const key of ['text', 'message', 'detail', 'reason']) {
      if (typeof object[key] === 'string') return object[key];
    }
  }
  return value === undefined ? '' : JSON.stringify(value, null, 2);
}

export function eventLabel(event: TaskEvent): string {
  const kind = record(event.payload)?.['kind'];
  return event.kind === 'stream' && typeof kind === 'string' ? kind : event.kind;
}
