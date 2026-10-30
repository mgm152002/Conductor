import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SnoozePickerDialog } from '../../src/renderer/components/threads/SnoozePickerDialog';

describe('SnoozePickerDialog', () => {
  it('offers wake-time presets and a custom time instead of snoozing immediately', () => {
    const html = renderToStaticMarkup(createElement(SnoozePickerDialog, {
      open: true, onClose: () => undefined, onSnooze: () => undefined,
    }));
    expect(html).toContain('Snooze thread');
    expect(html).not.toContain('moves to Snoozed and wakes');
    expect(html).toContain('For 1 hour');
    expect(html).toContain('Later today');
    expect(html).toContain('Tomorrow');
    expect(html).toContain('Next week');
    expect(html).toContain('Until I wake it');
    expect(html).toContain('type="datetime-local"');
    expect(html).toContain('aria-label="Custom wake time"');
  });
});
