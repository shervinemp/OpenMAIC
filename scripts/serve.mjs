/**
 * Personal local media setup: starts Ollama (optional local LLM), Kokoro TTS,
 * ComfyUI, and the OpenMAIC dev server — each idempotently (skips anything
 * already listening).
 *
 *   pnpm serve                     → start everything available
 *   pnpm serve kokoro              → start only Kokoro
 *   pnpm serve comfyui openmaic    → start only ComfyUI + OpenMAIC
 *
 * Ctrl+C stops the processes it started. Paths below are machine-specific
 * (see LOCAL-RUNBOOK.md — do not commit that file). Provider selection stays
 * in the app's Settings UI; this script only makes the servers reachable.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// OpenMAIC runs on the first free port starting here (Next auto-increments
// when a port is taken); these probes use an OpenMAIC-only route so a foreign
// server squatting on a port can never be mistaken for OpenMAIC.
const OPENMAIC_CANDIDATE_PORTS = [3000, 3001, 3002, 3003, 3004];

const SERVICES = {
  ollama: {
    label: 'Ollama',
    cmd: 'C:\\Users\\sherv\\AppData\\Local\\Programs\\Ollama\\ollama.exe',
    args: ['serve'],
    cwd: 'C:\\Users\\sherv\\AppData\\Local\\Programs\\Ollama',
    healthUrl: 'http://localhost:11434',
    timeoutMs: 60_000,
  },
  kokoro: {
    label: 'Kokoro TTS',
    cmd: 'C:\\Users\\sherv\\kokoro\\.venv\\Scripts\\python.exe',
    args: ['C:\\Users\\sherv\\kokoro\\kokoro_server.py'],
    cwd: 'C:\\Users\\sherv\\kokoro',
    healthUrl: 'http://127.0.0.1:8080/health',
    timeoutMs: 30_000,
  },
  comfyui: {
    label: 'ComfyUI',
    cmd: 'C:\\Users\\sherv\\Desktop\\New folder\\ComfyUI-Easy-Install\\python_embeded\\python.exe',
    args: [
      '-I',
      '-W',
      'ignore::FutureWarning',
      'ComfyUI\\main.py',
      '--windows-standalone-build',
      '--use-flash-attention',
    ],
    cwd: 'C:\\Users\\sherv\\Desktop\\New folder\\ComfyUI-Easy-Install',
    healthUrl: 'http://localhost:8188/system_stats',
    timeoutMs: 120_000,
  },
  openmaic: {
    label: 'OpenMAIC dev server',
    cmd: process.execPath,
    args: [fileURLToPath(new URL('../node_modules/next/dist/bin/next', import.meta.url)), 'dev'],
    cwd: ROOT,
    // Probe an OpenMAIC-only route across candidate ports: Next picks the
    // first free port (3000, 3001, ...), and only a real OpenMAIC responds
    // 200 here — a foreign server on the same port 404s.
    healthUrl: OPENMAIC_CANDIDATE_PORTS.map(
      (port) => `http://localhost:${port}/api/comfyui-workflows`,
    ),
    timeoutMs: 90_000,
  },
};

const children = new Map();
const started = new Map();

function log(service, msg) {
  console.log(`[${service.label}] ${msg}`);
}

async function isUp(url, timeoutMs = 2000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

async function isServiceUp(service) {
  const urls = Array.isArray(service.healthUrl) ? service.healthUrl : [service.healthUrl];
  for (const url of urls) {
    if (await isUp(url)) return true;
  }
  return false;
}

function pipe(child, service) {
  child.stdout?.on('data', (d) => process.stdout.write(`[${service.label}] ${d}`));
  child.stderr?.on('data', (d) => process.stderr.write(`[${service.label}] ${d}`));
  child.on('exit', (code) => {
    log(service, `exited (code ${code})`);
    children.delete(service.name);
  });
}

async function start(name, service) {
  if (await isServiceUp(service)) {
    log(service, 'already running — skipping');
    started.set(name, false);
    return;
  }
  log(service, `starting: ${service.cmd} ${service.args.join(' ')}`);
  const child = spawn(service.cmd, service.args, { cwd: service.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
  children.set(name, child);
  pipe(child, service);

  const deadline = Date.now() + service.timeoutMs;
  while (Date.now() < deadline) {
    if (await isServiceUp(service)) {
      const urls = Array.isArray(service.healthUrl) ? service.healthUrl : [service.healthUrl];
      for (const url of urls) {
        if (await isUp(url)) {
          log(service, `ready (${url})`);
          break;
        }
      }
      started.set(name, true);
      return;
    }
    await sleep(2000);
  }
  log(service, `WARNING: not healthy after ${service.timeoutMs / 1000}s — continuing anyway`);
  started.set(name, true);
}

async function stopAll() {
  console.log('\nStopping started services…');
  for (const [name, child] of children) {
    if (!started.get(name)) continue;
    log(SERVICES[name], 'stopping');
    child.kill('SIGTERM');
    const gone = await Promise.race([
      new Promise((r) => child.once('exit', () => r(true))),
      sleep(5000).then(() => false),
    ]);
    if (!gone) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    }
  }
}

const only = process.argv.slice(2);
const names = only.length
  ? only
  : ['ollama', 'kokoro', 'comfyui', 'openmaic'];
let hadError = false;

for (const name of names) {
  if (!SERVICES[name]) {
    console.error(`Unknown service "${name}". Valid: ${Object.keys(SERVICES).join(', ')}`);
    hadError = true;
  }
}
if (hadError) process.exit(1);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await stopAll();
    process.exit(0);
  });
}

await Promise.all(names.map((name) => start(name, SERVICES[name])));
console.log('All requested services are up — Ctrl+C to stop what this script started.');
