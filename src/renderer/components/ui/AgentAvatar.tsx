import { useId } from 'react';
import { cn } from '../../lib/cn';

// A sandbox agent's character: a small creature drawn in SVG, generated from
// the agent's name (body shape, eyes, accessory) in the agent's colour, so
// every agent is recognisable at a glance and stays the same between runs.
// It is static: the face shows the mood (focused while working, looking up
// while waiting for you, happy when done, worried on errors) and a small
// badge shows the status.

export type AgentMood = 'idle' | 'working' | 'waiting' | 'done' | 'error';

function hash(text: string): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i += 1) value = Math.imul(value ^ text.charCodeAt(i), 16777619) >>> 0;
  return value;
}

/** Body outlines on a 64×64 canvas; all leave room for an accessory above. */
const BODIES = [
  // Rounded square
  'M14 22c0-6 4-10 10-10h16c6 0 10 4 10 10v20c0 6-4 10-10 10H24c-6 0-10-4-10-10z',
  // Round
  'M32 12c11 0 20 9 20 20s-9 20-20 20-20-9-20-20 9-20 20-20z',
  // Drop / bean
  'M32 11c10 0 19 8 19 19 0 13-8 22-19 22s-19-9-19-22c0-11 9-19 19-19z',
  // Soft hexagon
  'M24 13h16c3 0 5 1 7 4l6 10c1 3 1 5 0 8l-6 10c-2 3-4 4-7 4H24c-3 0-5-1-7-4l-6-10c-1-3-1-5 0-8l6-10c2-3 4-4 7-4z',
] as const;

type Accessory = 'antenna' | 'ears' | 'halo' | 'sprout' | 'none';
const ACCESSORIES: Accessory[] = ['antenna', 'ears', 'halo', 'sprout', 'antenna', 'none'];
type Eyes = 'round' | 'tall' | 'wide';
const EYES: Eyes[] = ['round', 'tall', 'wide'];

/** Mix a hex colour toward white (amount > 0) or black (amount < 0). */
function shade(hex: string, amount: number): string {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  const channel = (shift: number): number => {
    const c = (n >> shift) & 0xff;
    return Math.round(amount >= 0 ? c + (255 - c) * amount : c * (1 + amount));
  };
  return `rgb(${channel(16)} ${channel(8)} ${channel(0)})`;
}

export function AgentAvatar({ agent, size = 36, mood = 'idle', className }: {
  agent: { name: string; color: string };
  size?: number;
  mood?: AgentMood;
  className?: string;
}): React.JSX.Element {
  const uid = useId().replace(/:/g, '');
  const seed = hash(agent.name.trim().toLowerCase() || 'agent');
  const body = BODIES[seed % BODIES.length]!;
  const accessory = ACCESSORIES[(seed >>> 3) % ACCESSORIES.length]!;
  const eyes = EYES[(seed >>> 7) % EYES.length]!;
  const color = /^#[0-9a-f]{6}$/i.test(agent.color) ? agent.color : '#c9379a';
  const small = size < 28;
  const eyeRx = eyes === 'wide' ? 5 : 4;
  const eyeRy = eyes === 'tall' ? 6 : eyes === 'wide' ? 4 : 4.6;
  const mouth = mood === 'done' ? 'M26 40q6 6 12 0'
    : mood === 'error' ? 'M26 42q3-3 6 0t6 0'
      : mood === 'waiting' ? 'M28 41h8'
        : mood === 'working' ? 'M30 40.5a2 2 0 1 0 4 0a2 2 0 1 0-4 0'
          : 'M27 40q5 3.5 10 0';

  return (
    <span
      className={cn('relative inline-flex shrink-0', className)}
      style={{ width: size, height: size, ['--agent-color' as string]: color }}
      aria-hidden="true"
    >
      <svg viewBox="7 0 50 54" width={size} height={size} className="relative overflow-visible" style={mood === 'error' ? { filter: 'saturate(0.75)' } : undefined}>
        <defs>
          <radialGradient id={`b-${uid}`} cx="35%" cy="30%" r="80%">
            <stop offset="0%" stopColor={shade(color, 0.42)} />
            <stop offset="55%" stopColor={color} />
            <stop offset="100%" stopColor={shade(color, -0.35)} />
          </radialGradient>
        </defs>
        <g>
          {accessory === 'antenna' && !small ? (
            <g>
              <path d="M32 13V6" stroke={shade(color, -0.3)} strokeWidth="2" strokeLinecap="round" />
              <circle cx="32" cy="5" r="3" fill={mood === 'working' ? '#fff6c2' : shade(color, 0.55)} />
            </g>
          ) : null}
          {accessory === 'ears' && !small ? (
            <g fill={shade(color, -0.15)}>
              <path d="M16 20l-3-10 10 5z" />
              <path d="M48 20l3-10-10 5z" />
            </g>
          ) : null}
          {accessory === 'sprout' && !small ? (
            <g>
              <path d="M32 13c0-4 0-6 0-7" stroke="#3f9a5a" strokeWidth="2" strokeLinecap="round" />
              <path d="M32 7c-5-4-9-1-8 1 3 2 6 1 8-1zM32 7c5-4 9-1 8 1-3 2-6 1-8-1z" fill="#5cc27a" />
            </g>
          ) : null}
          <path d={body} fill={`url(#b-${uid})`} />
          {/* Cheek glow and a soft highlight give it volume. */}
          <ellipse cx="25" cy="21" rx="7" ry="3.5" fill="white" opacity="0.22" />
          {!small ? (
            <g opacity={mood === 'done' ? 0.55 : 0.32} fill={shade(color, 0.6)}>
              <circle cx="20" cy="38" r="3" />
              <circle cx="44" cy="38" r="3" />
            </g>
          ) : null}
          {accessory === 'halo' && !small ? (
            <ellipse cx="32" cy="7" rx="11" ry="3" fill="none" stroke="#f6d36b" strokeWidth="2" />
          ) : null}
          <g>
            {mood === 'done' ? (
              <g stroke="#1b1424" strokeWidth="2.4" fill="none" strokeLinecap="round">
                <path d="M21 31q4-4 8 0" />
                <path d="M35 31q4-4 8 0" />
              </g>
            ) : (
              <g>
                <ellipse cx="25" cy="30" rx={eyeRx} ry={eyeRy} fill="white" />
                <ellipse cx="39" cy="30" rx={eyeRx} ry={eyeRy} fill="white" />
                <g fill="#1b1424" transform={mood === 'working' ? 'translate(1.4 0.6)' : undefined}>
                  <circle cx="25" cy={mood === 'waiting' ? 28.5 : 30.5} r={mood === 'error' ? 1.6 : 2.3} />
                  <circle cx="39" cy={mood === 'waiting' ? 28.5 : 30.5} r={mood === 'error' ? 1.6 : 2.3} />
                  <circle cx="26" cy={mood === 'waiting' ? 27.5 : 29.5} r="0.8" fill="white" />
                  <circle cx="40" cy={mood === 'waiting' ? 27.5 : 29.5} r="0.8" fill="white" />
                </g>
              </g>
            )}
            {mood === 'error' ? (
              <g stroke="#1b1424" strokeWidth="1.8" strokeLinecap="round">
                <path d="M20 22.5l6 2" />
                <path d="M44 22.5l-6 2" />
              </g>
            ) : null}
          </g>
          <path d={mouth} stroke="#1b1424" strokeWidth="2.2" fill={mood === 'working' ? '#1b1424' : 'none'} strokeLinecap="round" strokeLinejoin="round" />
        </g>
      </svg>
      {mood !== 'idle' ? (
        <span className={`agent-badge agent-badge-${mood}`} title={mood === 'working' ? 'Working' : mood === 'waiting' ? 'Waiting for you' : mood === 'done' ? 'Done' : 'Needs a look'}>
          {small ? null : mood === 'done' ? '✓' : mood === 'error' ? '!' : null}
        </span>
      ) : null}
    </span>
  );
}
