import { z } from 'zod';

// Custom icons for Spaces and projects (workspaces). An icon is stored as a
// self-contained data URL so it renders offline with no file access:
// generated icons are sanitized SVG, uploaded icons are raster/SVG images
// the user picked. The size cap keeps an icon well inside the IPC payload
// limit and the sidebar render budget.

export const MAX_ICON_DATA_URL_LENGTH = 262_144; // 256 KiB of data URL text

const RASTER_PREFIX = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\s]+$/;
const SVG_PREFIX = /^data:image\/svg\+xml(;charset=utf-8)?,/;

export function isValidIconDataUrl(value: string): boolean {
  if (value.length === 0 || value.length > MAX_ICON_DATA_URL_LENGTH) return false;
  if (RASTER_PREFIX.test(value)) return true;
  if (!SVG_PREFIX.test(value)) return false;
  // SVG is markup: never accept anything scriptable.
  let svg: string;
  try { svg = decodeURIComponent(value.slice(value.indexOf(',') + 1)); } catch { return false; }
  if (!/<svg[\s>]/i.test(svg)) return false;
  return !/(<script|<foreignObject|javascript:|\son\w+\s*=)/i.test(svg);
}

/** A stored icon data URL, or null to clear the custom icon. */
export const IconDataUrl = z.string().refine(isValidIconDataUrl, {
  message: 'Icon must be a PNG/JPEG/WebP/GIF/SVG data URL under 256 KiB',
});

export type IconTargetKind = 'space' | 'project';

export const GenerateIconRequest = z.object({
  targetKind: z.enum(['space', 'project']),
  /** Display name the icon should represent. */
  name: z.string().trim().min(1).max(255),
  /** Optional user description steering the design. */
  prompt: z.string().trim().max(500).optional(),
  /** Generation always uses the picked agent + model (`model`); omitted means any available agent may answer. */
  mode: z.enum(['model']).optional(),
  agentId: z.string().trim().regex(/^[\w:.-]{1,200}$/).optional(),
  model: z.string().regex(/^[\w./:@-]{1,100}$/).optional(),
}).strict();

export type GenerateIconInput = z.infer<typeof GenerateIconRequest>;

export const ICON_SCHEMAS = {
  'icon.generate': GenerateIconRequest,
} as const;

export interface IconBridge {
  /** Generate an icon with a model; resolves to a sanitized SVG data URL. Nothing is saved until the caller sets it. */
  generate(input: GenerateIconInput): Promise<string>;
}
