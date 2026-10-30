import { beforeEach, describe, expect, it } from 'vitest';
import { useComposerStore } from '../../src/renderer/stores/composer-store';

// The personal-chat CLI/model selection must survive sending a message and
// switching threads/CLIs: it changes only when the user picks something else.
describe('composer store chat selection', () => {
  beforeEach(() => { useComposerStore.getState().reset(); });

  it('keeps the chat CLI and each CLI’s model choice until the user changes them', () => {
    const store = useComposerStore.getState();
    store.setChatAgentId('opencode');
    store.setChatChoice('opencode', { model: 'opencode/deepseek-v4.1-flash-free', effort: 'low' });
    store.setChatChoice('codex', { model: 'gpt-5-codex' });

    const after = useComposerStore.getState();
    expect(after.chatAgentId).toBe('opencode');
    // Switching to Codex and back does not clear either CLI's model.
    expect(after.chatChoices['opencode']).toEqual({ model: 'opencode/deepseek-v4.1-flash-free', effort: 'low' });
    expect(after.chatChoices['codex']).toEqual({ model: 'gpt-5-codex' });

    after.setChatChoice('opencode', { model: 'opencode/kimi-k2' });
    expect(useComposerStore.getState().chatChoices['opencode']).toEqual({ model: 'opencode/kimi-k2' });
    expect(useComposerStore.getState().chatChoices['codex']).toEqual({ model: 'gpt-5-codex' });
  });
});
