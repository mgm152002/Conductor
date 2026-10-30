import { expect, it } from 'vitest';
import { threadTitle } from '../../src/renderer/lib/thread-status';

it('prefers a user-renamed title over the objective', () => {
  expect(threadTitle({ objective: 'Original first message\nwith details', title: 'My thread' })).toBe('My thread');
});

it('falls back to the first objective line without a rename', () => {
  expect(threadTitle({ objective: '\nFirst line\nSecond line' })).toBe('First line');
  expect(threadTitle({ objective: 'Objective', title: '   ' })).toBe('Objective');
  expect(threadTitle({ objective: '' })).toBe('Untitled task');
});
