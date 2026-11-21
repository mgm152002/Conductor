import { extendTailwindMerge } from 'tailwind-merge';

// Join class names and let later Tailwind classes win over earlier ones, as
// cn() should (tailwind-merge), so a call site can override a
// shared recipe (size-7 over size-8). The app's extra font sizes are
// registered so text-2xs is read as a size, not a colour.
const twMerge = extendTailwindMerge({
  extend: { theme: { text: ['2xs', '3xs'] } },
});

export function cn(...values: Array<string | false | null | undefined>): string {
  return twMerge(values.filter(Boolean).join(' '));
}
