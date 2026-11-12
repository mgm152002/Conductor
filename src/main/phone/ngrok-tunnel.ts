import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';

// Runs `ngrok http <port>` and reads the public address from its JSON log.
// Conductor never touches the user's ngrok account: the CLI uses the auth
// token the user already configured with `ngrok config add-authtoken`.

const CANDIDATES = ['/opt/homebrew/bin/ngrok', '/usr/local/bin/ngrok', '/usr/bin/ngrok'];

export function findNgrok(): string | undefined {
  return CANDIDATES.find((path) => existsSync(path));
}

export interface Tunnel { url: string; stop(): void }

/** Plain-language reason from ngrok's own error text. */
export function explainNgrokError(text: string): string {
  if (/ERR_NGROK_4018|authtoken|authentication failed/i.test(text)) return 'ngrok needs an account token. Run “ngrok config add-authtoken <token>” in Terminal once (from dashboard.ngrok.com), then try again.';
  if (/ERR_NGROK_108|limited to 1 simultaneous|already online/i.test(text)) return 'Another ngrok tunnel is already running on this account. Close it, then try again.';
  if (/ENOTFOUND|dial tcp|connection refused|no such host|network/i.test(text)) return 'Couldn’t reach ngrok. Check your internet connection.';
  const line = text.split('\n').map((l) => l.trim()).find((l) => /err|fail/i.test(l));
  return line !== undefined ? `ngrok reported: ${line.slice(0, 200)}` : 'ngrok stopped before the tunnel was ready.';
}

export function startTunnel(binary: string, port: number, onExit: (reason: string) => void, timeoutMs = 25_000): Promise<Tunnel> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(binary, ['http', `127.0.0.1:${port}`, '--log=stdout', '--log-format=json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false;
    let buffer = '';
    let errors = '';
    const timer = setTimeout(() => finish(new Error('ngrok took too long to start.')), timeoutMs);
    const stop = (): void => { if (!child.killed) child.kill('SIGTERM'); };
    function finish(error: Error | null, url?: string): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== null) { stop(); reject(error); } else resolve({ url: url!, stop });
    }
    const read = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8');
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        try {
          const entry = JSON.parse(line) as { msg?: string; url?: string; err?: string; lvl?: string };
          if (entry.msg === 'started tunnel' && typeof entry.url === 'string' && entry.url.startsWith('https://')) finish(null, entry.url);
          if (entry.err !== undefined && entry.err !== '<nil>' && entry.err !== 'nil') errors += `${entry.err}\n`;
        } catch { errors += `${line}\n`; }
      }
    };
    child.stdout?.on('data', read);
    child.stderr?.on('data', (chunk: Buffer) => { errors += chunk.toString('utf8'); });
    child.once('error', (error) => { finish(new Error(`Couldn’t start ngrok: ${error.message}`)); });
    child.once('exit', () => {
      if (!settled) finish(new Error(explainNgrokError(errors)));
      else onExit(explainNgrokError(errors));
    });
  });
}
