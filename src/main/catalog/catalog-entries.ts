// Agent CLI catalog. Install commands and binary names were checked against
// each vendor's documentation and the npm / Homebrew registries (2026-10-24):
//   Codex        https://developers.openai.com/codex/cli         npm @openai/codex → codex
//   Claude Code  https://code.claude.com/docs/en/setup           Homebrew cask claude-code → claude
//   OpenCode     https://opencode.ai/docs/cli                    npm opencode-ai → opencode
//   Antigravity  https://antigravity.google/product/antigravity-cli  Homebrew cask antigravity-cli → agy
//   Command Code https://commandcode.ai/docs                      npm command-code → command-code / cmd
//   Kiro         https://kiro.dev/docs/cli/                      install script only → kiro-cli
//
// Kiro publishes only a `curl … | bash` installer. Conductor never runs
// pipe-to-shell commands, so that entry shows the command for the user to run.
import type { CatalogEntry } from '../../shared/catalog';

export const CATALOG_ENTRIES = [
  { id: 'antigravity', displayName: 'Antigravity CLI', candidateBinaryNames: ['agy'], installMethod: { kind: 'brew_cask', cask: 'antigravity-cli' },
    setupNote: 'After installing, run `agy` once in a terminal to sign in with your Google account.' },
  { id: 'codex', displayName: 'Codex CLI', candidateBinaryNames: ['codex'], installMethod: { kind: 'npm', package: '@openai/codex', binName: 'codex' },
    setupNote: 'After installing, run `codex login` in a terminal.' },
  { id: 'claude-code', displayName: 'Claude Code', candidateBinaryNames: ['claude'], installMethod: { kind: 'brew_cask', cask: 'claude-code' },
    setupNote: 'After installing, run `claude` once in a terminal to sign in.' },
  { id: 'opencode', displayName: 'OpenCode', candidateBinaryNames: ['opencode'], installMethod: { kind: 'npm', package: 'opencode-ai', binName: 'opencode' },
    setupNote: 'After installing, run `opencode auth login` in a terminal to connect a model provider.' },
  { id: 'command-code', displayName: 'Command Code', candidateBinaryNames: ['command-code', 'cmdc'], installMethod: { kind: 'npm', package: 'command-code', binName: 'command-code' },
    setupNote: 'Command Code has no documented non-interactive mode, so Conductor can install it but not route tasks to it yet. Run `cmd` in a project to use it directly.' },
  { id: 'kiro', displayName: 'Kiro CLI', candidateBinaryNames: ['kiro-cli'], installMethod: { kind: 'manual', command: 'curl -fsSL https://cli.kiro.dev/install | bash', docsUrl: 'https://kiro.dev/docs/cli/' },
    setupNote: 'After installing, run `kiro-cli login` in a terminal (or set KIRO_API_KEY).' },
] as const satisfies readonly CatalogEntry[];
