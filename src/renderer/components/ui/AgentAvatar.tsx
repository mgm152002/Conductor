import { cn } from '../../lib/cn';

// A sandbox agent's icon: the image the user uploaded or generated, or, until
// one is set, its initial on its colour. A small badge shows its status.

export type AgentMood = 'idle' | 'working' | 'waiting' | 'done' | 'error';

const MOOD_TITLE: Record<Exclude<AgentMood, 'idle'>, string> = {
  working: 'Working', waiting: 'Waiting for you', done: 'Done', error: 'Needs a look',
};

export function AgentAvatar({ agent, size = 36, mood = 'idle', className }: {
  agent: { name: string; color: string; icon?: string | undefined };
  size?: number;
  mood?: AgentMood;
  className?: string;
}): React.JSX.Element {
  const color = /^#[0-9a-f]{6}$/i.test(agent.color) ? agent.color : '#c9379a';
  const initial = [...agent.name.trim()][0]?.toUpperCase() ?? '?';
  const hasIcon = agent.icon !== undefined && agent.icon !== '';
  const radius = Math.max(6, Math.round(size * 0.28));
  return (
    <span
      className={cn('relative inline-flex shrink-0', className)}
      style={{ width: size, height: size, ['--agent-color' as string]: color }}
      aria-hidden="true"
    >
      {hasIcon ? (
        <img src={agent.icon} alt="" width={size} height={size} draggable={false} className="size-full object-cover" style={{ borderRadius: radius }} />
      ) : (
        <span
          className="flex size-full items-center justify-center font-semibold text-white"
          style={{ borderRadius: radius, background: `linear-gradient(135deg, ${color}, color-mix(in srgb, ${color} 70%, black))`, fontSize: Math.round(size * 0.46) }}
        >
          {initial}
        </span>
      )}
      {mood !== 'idle' ? (
        <span className={`agent-badge agent-badge-${mood}`} title={MOOD_TITLE[mood]}>
          {size < 28 ? null : mood === 'done' ? '✓' : mood === 'error' ? '!' : null}
        </span>
      ) : null}
    </span>
  );
}
