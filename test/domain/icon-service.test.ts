import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '@main/db/store';
import { Registry } from '@main/registry/registry';
import { ChatService } from '@main/domain/chat-service';
import { WorkspaceService } from '@main/domain/workspace-service';
import { IconService, buildIconPrompt, cleanGeneratedIconSvg } from '@main/domain/icon-service';
import { isValidIconDataUrl } from '@shared/icon-contract';

const SVG = '<svg viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0f766e"/><circle cx="32" cy="32" r="12" fill="#fff"/></svg>';
const SVG_URL = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(SVG)}`;
const PNG_URL = 'data:image/png;base64,iVBORw0KGgo=';

describe('icon data URLs', () => {
  it('accepts generated SVG and uploaded raster icons, rejects scriptable SVG', () => {
    expect(isValidIconDataUrl(SVG_URL)).toBe(true);
    expect(isValidIconDataUrl(PNG_URL)).toBe(true);
    const evil = `data:image/svg+xml,${encodeURIComponent('<svg onload="alert(1)"><script>alert(1)</script></svg>')}`;
    expect(isValidIconDataUrl(evil)).toBe(false);
    expect(isValidIconDataUrl('https://example.com/icon.png')).toBe(false);
  });

  it('sanitizes a model reply down to a safe SVG data URL', () => {
    const raw = `Here you go:\n\`\`\`svg\n<svg viewBox="0 0 64 64" onclick="x()"><script>alert(1)</script><rect width="64" height="64" fill="#000"/></svg>\n\`\`\``;
    const icon = cleanGeneratedIconSvg(raw);
    expect(icon).toBeDefined();
    const decoded = decodeURIComponent(icon!.slice(icon!.indexOf(',') + 1));
    expect(decoded).not.toMatch(/script|onclick/i);
    expect(decoded).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(cleanGeneratedIconSvg('no svg here')).toBeUndefined();
  });

  it('builds a prompt naming the target and the user description', () => {
    const prompt = buildIconPrompt({ targetKind: 'space', name: 'Trip planning', prompt: 'a paper plane' });
    expect(prompt).toContain('Trip planning');
    expect(prompt).toContain('a paper plane');
    expect(prompt).toContain('SVG');
  });
});

describe('IconService', () => {
  it('pins the exact agent and model picked', async () => {
    const generateText = vi.fn(async () => SVG);
    const service = new IconService({ generateText });
    await expect(service.generate({ targetKind: 'project', name: 'Api', mode: 'model', agentId: 'claude', model: 'sonnet' })).resolves.toBe(cleanGeneratedIconSvg(SVG));
    expect(generateText).toHaveBeenLastCalledWith(expect.stringContaining('Api'), expect.any(String), { agentId: 'claude', model: 'sonnet' });
  });

  it('fails with guidance when the agent returns no usable SVG', async () => {
    const service = new IconService({ generateText: async () => 'sorry, no' });
    await expect(service.generate({ targetKind: 'space', name: 'Trips' })).rejects.toThrow(/upload an icon/);
  });
});

describe('space and workspace icon persistence', () => {
  it('stores, reads back and clears icons', async () => {
    const root = mkdtempSync(join(tmpdir(), 'conductor-icons-'));
    const store = new SqliteStore(join(root, 'test.db'));
    try {
      await store.migrate();
      const workspaces = new WorkspaceService(store);
      const project = workspaces.create({ name: 'Api', rootPath: root });
      expect(workspaces.setIcon(project.id, PNG_URL).icon).toBe(PNG_URL);
      expect(workspaces.list()[0]?.icon).toBe(PNG_URL);
      expect(workspaces.setIcon(project.id, null).icon).toBeNull();
      expect(() => workspaces.setIcon(project.id, 'not-an-icon')).toThrow(/Icon must be/);

      const chat = new ChatService(store, new Registry(), join(root, 'sandbox'));
      const space = chat.createSpace('Trip planning');
      expect(chat.setSpaceIcon(space.id, SVG_URL).icon).toBe(SVG_URL);
      expect(chat.listSpaces()[0]?.icon).toBe(SVG_URL);
      expect(chat.setSpaceIcon(space.id, null).icon).toBeNull();
      expect(() => chat.setSpaceIcon(space.id, 'data:text/html;base64,PHNjcmlwdD4=')).toThrow(/Icon must be/);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
