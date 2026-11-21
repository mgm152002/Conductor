import { createElement, useMemo, useRef, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  Anchor, Atom, Book, BookOpen, Bot, Brain, Briefcase, Bug, Calendar, Camera, ChartColumn, Cloud, CloudCog, Code, Coffee,
  Compass, Cpu, Database, Feather, FileText, Flame, FlaskConical, FolderCode, Gamepad2, Gift, GitBranch, Globe, GraduationCap,
  Hammer, Headphones, Heart, House, Image as ImageGlyph, Key, Landmark, Layers, Leaf, Lightbulb, Mail, Map as MapGlyph,
  MessageSquare, Mic, Monitor, Moon, Music, Newspaper, Package, Palette, PenTool, Plane, Puzzle, Rocket, Scissors, Search,
  Send, Server, Settings, Shapes, ShieldCheck, ShoppingBag, Smartphone, Sparkles, Sprout, Star, Sun, Tag, Target, Telescope,
  Terminal, Ticket, Trophy, Truck, Umbrella, Users, Video, Wallet, Waves, Workflow, Wrench, Zap,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { inputClassName } from '../ui/primitives';

// The icon chooser for projects, spaces and agents: an icon from a curated
// set, an emoji, or one or two letters, each in a colour — or your own image.
// Whatever is picked is drawn as a small SVG tile, so it is stored and shown
// exactly like an uploaded image.

const ICONS: ReadonlyArray<readonly [string, LucideIcon]> = [
  ['folder-code', FolderCode], ['code', Code], ['terminal', Terminal], ['globe', Globe], ['server', Server], ['database', Database],
  ['bot', Bot], ['sparkles', Sparkles], ['smartphone', Smartphone], ['monitor', Monitor], ['cloud-cog', CloudCog], ['package', Package],
  ['book-open', BookOpen], ['flask', FlaskConical], ['shield-check', ShieldCheck], ['rocket', Rocket], ['gamepad', Gamepad2], ['music', Music],
  ['image', ImageGlyph], ['shopping-bag', ShoppingBag], ['git-branch', GitBranch], ['workflow', Workflow], ['wrench', Wrench], ['layers', Layers],
  ['brain', Brain], ['briefcase', Briefcase], ['calendar', Calendar], ['camera', Camera], ['chart', ChartColumn], ['cloud', Cloud],
  ['coffee', Coffee], ['compass', Compass], ['cpu', Cpu], ['feather', Feather], ['file-text', FileText], ['flame', Flame],
  ['gift', Gift], ['graduation-cap', GraduationCap], ['hammer', Hammer], ['headphones', Headphones], ['heart', Heart], ['house', House],
  ['key', Key], ['landmark', Landmark], ['leaf', Leaf], ['lightbulb', Lightbulb], ['mail', Mail], ['map', MapGlyph],
  ['message', MessageSquare], ['mic', Mic], ['moon', Moon], ['newspaper', Newspaper], ['palette', Palette], ['pen-tool', PenTool],
  ['plane', Plane], ['puzzle', Puzzle], ['scissors', Scissors], ['search', Search], ['send', Send], ['settings', Settings],
  ['shapes', Shapes], ['sprout', Sprout], ['star', Star], ['sun', Sun], ['tag', Tag], ['target', Target],
  ['telescope', Telescope], ['ticket', Ticket], ['trophy', Trophy], ['truck', Truck], ['umbrella', Umbrella], ['users', Users],
  ['video', Video], ['wallet', Wallet], ['waves', Waves], ['zap', Zap], ['anchor', Anchor], ['atom', Atom],
  ['book', Book], ['bug', Bug],
];

export const ICON_COLORS: ReadonlyArray<readonly [string, string]> = [
  ['Gray', '#71717a'], ['Red', '#ef4444'], ['Orange', '#f97316'], ['Amber', '#f59e0b'], ['Lime', '#65a30d'], ['Green', '#16a34a'],
  ['Teal', '#0d9488'], ['Sky', '#0284c7'], ['Blue', '#2563eb'], ['Indigo', '#4f46e5'], ['Violet', '#7c3aed'], ['Pink', '#db2777'],
];

const EMOJIS = ['💻', '🛠️', '🚀', '🤖', '✨', '⚡', '🌐', '📱', '🖥️', '⌨️', '⚙️', '🗄️', '☁️', '📦', '📚', '🧪', '🔒', '🎮', '🎵', '🎬', '🖼️', '🛍️', '🔥', '💡', '🧩', '📊', '🧠', '🦄', '🐙', '🌱', '✈️', '📝', '🎯', '🏆', '💼', '🔍'];

export type IconChoice =
  | { kind: 'icon'; name: string; color: string }
  | { kind: 'emoji'; emoji: string }
  | { kind: 'monogram'; text: string; color: string }
  | { kind: 'image'; dataUrl: string };

const escapeXml = (text: string): string => text.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A picked icon, emoji or monogram as a 40×40 SVG tile: the glyph in its colour over a soft tint of it. */
export function choiceSvg(choice: Exclude<IconChoice, { kind: 'image' }>): string {
  const tile = (color: string, body: string): string =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="10" fill="${color}" fill-opacity="0.16"/>${body}</svg>`;
  if (choice.kind === 'emoji') {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><text x="20" y="21" font-size="28" text-anchor="middle" dominant-baseline="central">${escapeXml(choice.emoji)}</text></svg>`;
  }
  if (choice.kind === 'monogram') {
    const size = [...choice.text].length > 1 ? 16 : 20;
    return tile(choice.color, `<text x="20" y="21" fill="${choice.color}" font-family="-apple-system, BlinkMacSystemFont, system-ui, sans-serif" font-size="${size}" font-weight="700" text-anchor="middle" dominant-baseline="central">${escapeXml(choice.text)}</text>`);
  }
  const Icon = ICONS.find(([name]) => name === choice.name)?.[1] ?? FolderCode;
  // The icon's own paths, without its outer <svg>, centred on the tile.
  const inner = renderToStaticMarkup(createElement(Icon)).replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
  return tile(choice.color, `<g transform="translate(8 8)" fill="none" stroke="${choice.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</g>`);
}

export const svgDataUrl = (svg: string): string => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

const monogramOf = (name: string): string => {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? 'P').slice(0, 2);
  return letters.toUpperCase();
};

type Tab = 'icon' | 'emoji' | 'monogram' | 'image';

/**
 * The chooser body. It reports every change through `onChange`, so a dialog
 * can preview and save it; `onImage` reads an uploaded file (and may reject it).
 */
export function IconChooser({ name, initialColor = '#2563eb', onChange, onImage }: {
  name: string;
  initialColor?: string;
  onChange: (choice: IconChoice) => void;
  onImage: (file: File) => Promise<string>;
}): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('icon');
  const [color, setColor] = useState(ICON_COLORS.find(([, hex]) => hex === initialColor)?.[1] ?? initialColor);
  const [iconName, setIconName] = useState<string | null>(null);
  const [emoji, setEmoji] = useState<string | null>(null);
  const [letters, setLetters] = useState(() => monogramOf(name));
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const icons = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/\s+/g, '-');
    return q === '' ? ICONS : ICONS.filter(([key]) => key.includes(q));
  }, [query]);
  const monogram = letters.normalize('NFKC').trim().toUpperCase();
  const validMonogram = /^[\p{L}\p{N}]{1,2}$/u.test(monogram);

  const pickColor = (next: string): void => {
    setColor(next);
    if (tab === 'icon' && iconName !== null) onChange({ kind: 'icon', name: iconName, color: next });
    if (tab === 'monogram' && validMonogram) onChange({ kind: 'monogram', text: monogram, color: next });
  };

  const tabs: Array<[Tab, string]> = [['icon', 'Icons'], ['emoji', 'Emoji'], ['monogram', 'Monogram'], ['image', 'Image']];
  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div role="group" aria-label="Icon type" className="seg-control self-start">
        {tabs.map(([id, label]) => (
          <button key={id} type="button" data-active={tab === id} aria-pressed={tab === id} className="seg-item focus-visible:outline-2 focus-visible:outline-ring"
            onClick={() => { setTab(id); setError(null); if (id === 'monogram' && validMonogram) onChange({ kind: 'monogram', text: monogram, color }); }}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'icon' || tab === 'monogram' ? (
        <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground">Color</p>
          <div role="group" aria-label="Icon color" className="flex flex-wrap gap-1.5">
            {ICON_COLORS.map(([label, hex]) => (
              <button key={hex} type="button" aria-label={label} aria-pressed={color === hex} onClick={() => { pickColor(hex); }}
                className={cn('flex size-6 cursor-pointer items-center justify-center rounded-full border border-transparent outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring', color === hex && 'border-foreground/60')}>
                <span className="size-4 rounded-full" style={{ background: hex }} />
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {tab === 'icon' ? (
        <>
          <input type="search" aria-label="Search icons" placeholder="Search icons" value={query} onChange={(event) => { setQuery(event.target.value); }} className={inputClassName} />
          <div className="flex max-h-56 flex-wrap gap-1 overflow-y-auto p-0.5">
            {icons.map(([key, Icon]) => (
              <button key={key} type="button" aria-label={key.replace(/-/g, ' ')} title={key.replace(/-/g, ' ')} aria-pressed={iconName === key}
                onClick={() => { setIconName(key); onChange({ kind: 'icon', name: key, color }); }}
                className={cn('flex size-9 cursor-pointer items-center justify-center rounded-md border border-transparent outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring', iconName === key && 'border-border bg-accent')}
                style={{ color }}>
                <Icon className="size-5" />
              </button>
            ))}
          </div>
          {icons.length === 0 ? <p className="py-6 text-center text-sm text-muted-foreground">No icons found.</p> : null}
        </>
      ) : tab === 'emoji' ? (
        <div className="flex max-h-56 flex-wrap gap-1 overflow-y-auto p-0.5">
          {EMOJIS.map((option) => (
            <button key={option} type="button" aria-label={option} aria-pressed={emoji === option}
              onClick={() => { setEmoji(option); onChange({ kind: 'emoji', emoji: option }); }}
              className={cn('flex size-9 cursor-pointer items-center justify-center rounded-md border border-transparent text-xl outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring', emoji === option && 'border-border bg-accent')}>
              {option}
            </button>
          ))}
        </div>
      ) : tab === 'monogram' ? (
        <div className="flex items-center gap-4 py-1">
          <img alt="" className="size-12 shrink-0" src={svgDataUrl(choiceSvg({ kind: 'monogram', text: validMonogram ? monogram : monogramOf(name), color }))} />
          <div className="flex-1 space-y-1.5">
            <label htmlFor="icon-monogram" className="text-sm font-medium text-foreground">Letters</label>
            <input id="icon-monogram" value={letters} maxLength={4} autoComplete="off" aria-invalid={!validMonogram} className={inputClassName}
              onChange={(event) => {
                const next = event.target.value;
                setLetters(next);
                const text = next.normalize('NFKC').trim().toUpperCase();
                if (/^[\p{L}\p{N}]{1,2}$/u.test(text)) onChange({ kind: 'monogram', text, color });
              }} />
            <p className="text-xs text-muted-foreground">One or two letters or numbers.</p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-start gap-2 py-1">
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" hidden aria-label="Upload an image"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file === undefined) return;
              setError(null);
              void onImage(file).then((dataUrl) => { onChange({ kind: 'image', dataUrl }); }).catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Could not use that image.'); });
            }} />
          <button type="button" onClick={() => { fileRef.current?.click(); }}
            className="flex h-8 cursor-pointer items-center rounded-lg border border-input bg-background px-3 text-sm text-foreground shadow-xs/5 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring">
            Choose an image…
          </button>
          <p className="text-xs text-muted-foreground">PNG, JPEG, WebP, GIF or SVG. It is cropped to a square.</p>
        </div>
      )}
      {error !== null ? <p role="alert" className="text-xs text-destructive-foreground">{error}</p> : null}
    </div>
  );
}
