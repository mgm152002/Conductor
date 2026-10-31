import type { GenerateIconInput } from '@shared/icon-contract';
import type { TitleRunPin } from './thread-title-service';

// Icon generation for Spaces and projects. A model is asked for a single
// self-contained SVG (no image model is attached to Conductor, and SVG keeps
// icons crisp at sidebar size and storable as a data URL). The reply is
// untrusted: only a sanitized <svg> survives — scripts, event handlers,
// foreign content and external references are stripped before storage.

export function buildIconPrompt(input: GenerateIconInput): string {
  const kind = input.targetKind === 'space' ? 'chat space (a group of related conversations)' : 'software project';
  return [
    `Design a simple app icon for a ${kind} named "${input.name}".`,
    ...(input.prompt ? [`The user describes it as: ${input.prompt}`] : []),
    'Reply with ONE self-contained SVG only — no markdown fences, no explanation.',
    'Requirements: viewBox="0 0 64 64", a rounded-square or circle background with 1-2 bold foreground shapes or a monogram, at most 4 flat colors, no text longer than 2 characters, no <script>, no event handlers, no external images/fonts, no gradients with external references. It must read clearly at 20x20 pixels.',
  ].join('\n');
}

/** Extract and sanitize the first SVG in a model reply; undefined if none is usable. */
export function cleanGeneratedIconSvg(raw: string): string | undefined {
  const match = /<svg[\s\S]*?<\/svg>/i.exec(raw.replace(/```[a-z]*\n?/gi, '\n'));
  if (match === null) return undefined;
  let svg = match[0]
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<image\b[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/(href|xlink:href)\s*=\s*"\s*(?!#)[^"]*"/gi, '')
    .replace(/(href|xlink:href)\s*=\s*'\s*(?!#)[^']*'/gi, '')
    .replace(/url\(\s*(?!#)[^)]*\)/gi, 'none')
    .trim();
  if (/(<script|javascript:|\son\w+\s*=)/i.test(svg)) return undefined;
  if (!/^<svg[\s>]/i.test(svg)) return undefined;
  if (!/\sxmlns\s*=/.test(svg)) svg = svg.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  if (!/\sviewBox\s*=/.test(svg)) svg = svg.replace(/<svg/i, '<svg viewBox="0 0 64 64"');
  if (svg.length > 32_000) return undefined;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export interface IconServiceDeps {
  /** Raw agent text for a prompt; with a pin, only that agent/model is asked. */
  generateText: (prompt: string, description: string, pin?: TitleRunPin) => Promise<string | undefined>;
}

export class IconService {
  constructor(private readonly deps: IconServiceDeps) {}

  async generate(input: GenerateIconInput): Promise<string> {
    // Pin the exact agent + model picked. No agent picked means any
    // available agent may draw.
    const pin: TitleRunPin | undefined = input.agentId === undefined
      ? undefined
      : {
          agentId: input.agentId,
          ...(input.model !== undefined ? { model: input.model } : {}),
        };
    const raw = await this.deps.generateText(
      buildIconPrompt(input),
      `Generate an icon for ${input.targetKind} "${input.name}"`,
      pin,
    ).catch(() => undefined);
    const icon = raw === undefined ? undefined : cleanGeneratedIconSvg(raw);
    if (icon === undefined) {
      throw new Error(input.agentId === undefined
        ? 'No available agent could generate an icon. Install/enable a local CLI agent, or upload an icon instead.'
        : 'That model returned no usable icon. Try again, pick another model, or upload an icon instead.');
    }
    return icon;
  }
}
