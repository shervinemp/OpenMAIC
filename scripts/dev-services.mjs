#!/usr/bin/env node
/**
 * Dev dependency supervisor.
 *
 * Local services are declared under their provider name in the environment or
 * .env.local (COMFYUI_START_CMD, LAYA_START_CMD, ...), or generically via
 * DEV_SERVICES_JSON / DEV_SERVICES_FILE. Polls each enabled service's health
 * URL and spawns/restarts any that are down. It can wrap the dev server:
 *
 *   pnpm dev                       # runs `node scripts/dev-services.mjs -- next dev`
 *   pnpm dev:services -- --check   # one health pass, no spawning (diagnostics)
 *
 * Config (DEV_SERVICES_JSON):
 *   {
 *     "intervalMs": 15000,
 *     "startGraceMs": 30000,
 *     "services": [
 *       {
 *         "name": "comfyui",
 *         "health": "http://127.0.0.1:8188/system_stats",
 *         "command": "C:\\path\\python.exe",
 *         "args": ["main.py", "--port", "8188"],
 *         "cwd": "C:\\path\\to\\ComfyUI",
 *         "log": "C:\\temp\\comfyui.log",
 *         "env": { "FOO": "bar" },
 *         "enabled": true
 *       }
 *     ]
 *   }
 *
 * No secret values are logged. Credentials belong in the service's own env,
 * never in this config. A service with `enabled: false` is reported but never
 * spawned. Health probes use a short timeout and a fetch failure (or 5xx)
 * counts as down; any other HTTP response means the process is alive.
 */

import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_ONLY = process.argv.includes('--check');
const SEP = process.argv.indexOf('--');
const FORWARD_ARGS = SEP >= 0 ? process.argv.slice(SEP + 1) : [];

const IS_WIN = process.platform === 'win32';

function log(message) {
  const stamp = new Date().toISOString().slice(11, 19);
  process.stdout.write(`[dev-services ${stamp}] ${message}\n`);
}

/** Minimal .env.local reader: never overrides values already in process.env. */
function loadDotEnv(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/u.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    let value = rawValue;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnv(join(ROOT, '.env.local'));

function readConfig() {
  let raw = process.env.DEV_SERVICES_JSON;
  if (!raw && process.env.DEV_SERVICES_FILE) {
    try {
      raw = readFileSync(resolvePath(process.env.DEV_SERVICES_FILE, ROOT), 'utf8');
    } catch (error) {
      log(`could not read DEV_SERVICES_FILE: ${error.message}`);
      return null;
    }
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? { services: parsed } : parsed;
  } catch (error) {
    log(`invalid service config; continuing with no services: ${error.message}`);
    return null;
  }
}

/** Prevent a scheduled-task supervisor and a `pnpm dev` wrapper from both spawning services. */
function acquireLock() {
  const path = join(tmpdir(), 'openmaic-dev-services', 'supervisor.lock');
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        log(`another supervisor is running (pid ${pid}); exiting`);
        return false;
      } catch {
        // stale lock
      }
    }
  }
  writeFileSync(path, String(process.pid));
  return true;
}

function releaseLock() {
  try {
    unlinkSync(join(tmpdir(), 'openmaic-dev-services', 'supervisor.lock'));
  } catch {
    // already gone
  }
}

if (!CHECK_ONLY && !acquireLock()) process.exit(0);

/**
 * Local providers can declare their start script directly in env, keyed by
 * provider name: OPENCODE_START_CMD, COMFYUI_START_CMD, LAYA_START_CMD, ...
 * Optional companions: <NAME>_ARGS (JSON array), <NAME>_HEALTH_URL,
 * <NAME>_CWD, <NAME>_LOG, <NAME>_ENV (JSON object), <NAME>_ENABLED (0/1),
 * <NAME>_SERVES (comma-separated provider ids one server backs).
 * This keeps a provider's runtime next to its other env configuration.
 */
function servicesFromProviderEnv() {
  const found = [];
  const seen = new Set();
  for (const key of Object.keys(process.env)) {
    const match = /^([A-Z][A-Z0-9_]*?)_START_CMD$/u.exec(key);
    if (!match) continue;
    const prefix = match[1];
    const name = prefix.toLowerCase();
    if (seen.has(name)) continue;
    seen.add(name);
    const get = (suffix) => process.env[`${prefix}_${suffix}`];
    const parseJson = (value, fallback, label) => {
      if (!value) return fallback;
      try {
        return JSON.parse(value);
      } catch {
        log(`invalid JSON in ${prefix}_${label}; ignoring`);
        return fallback;
      }
    };
    found.push({
      name,
      command: process.env[key],
      args: parseJson(get('ARGS'), [], 'ARGS'),
      health: get('HEALTH_URL'),
      cwd: get('CWD'),
      log: get('LOG'),
      env: parseJson(get('ENV'), {}, 'ENV'),
      serves: get('SERVES')
        ? get('SERVES').split(',').map((id) => id.trim()).filter(Boolean)
        : [],
      enabled: get('ENABLED') !== '0' && get('ENABLED') !== 'false',
    });
  }
  return found;
}

const config = readConfig();
const configured = config?.services;
const fromConfig = Array.isArray(configured)
  ? configured.filter((service) => service && typeof service === 'object')
  : configured && typeof configured === 'object'
    ? Object.entries(configured)
        .filter(([, service]) => service && typeof service === 'object')
        .map(([name, service]) => ({ ...service, name: service.name || name }))
    : [];
const envServices = servicesFromProviderEnv();
const seenNames = new Set(fromConfig.map((service) => service.name));
const services = [...fromConfig, ...envServices.filter((service) => !seenNames.has(service.name))];
const intervalMs = Math.max(1000, Number(config?.intervalMs) || 15000);
const startGraceMs = Math.max(1000, Number(config?.startGraceMs) || 30000);
const timeoutMs = Math.max(500, Number(config?.healthTimeoutMs) || 2500);
const children = new Map();
const lastSpawn = new Map();
const backoffUntil = new Map();
let stopping = false;

function resolvePath(value, fallback) {
  if (!value) return fallback;
  return isAbsolute(value) ? value : resolve(ROOT, value);
}

async function isHealthy(url) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

function spawnService(service) {
  const name = service.name || service.command;
  const cwd = resolvePath(service.cwd, ROOT);
  const logPath = resolvePath(
    service.log,
    join(tmpdir(), 'openmaic-dev-services', `${name}.log`),
  );
  mkdirSync(dirname(logPath), { recursive: true });
  let logFd;
  try {
    logFd = openSync(logPath, 'a');
  } catch {
    // We still spawn with ignored stdio in the unlikely case a log is unwritable.
  }
  const out = logFd ?? 'ignore';
  log(`spawning ${name}: ${service.command} (log: ${logPath})`);
  try {
    const child = spawn(service.command, Array.isArray(service.args) ? service.args : [], {
      cwd,
      env: { ...process.env, ...(service.env || {}) },
      detached: IS_WIN,
      stdio: ['ignore', out, out],
    });
    children.set(name, child);
    lastSpawn.set(name, Date.now());
    child.once('error', (error) => {
      log(`${name} failed to start: ${error.message}`);
      children.delete(name);
    });
    child.once('exit', (code, signal) => {
      log(`${name} exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`);
      children.delete(name);
      if (typeof logFd === 'number') closeSync(logFd);
    });
  } catch (error) {
    log(`could not spawn ${name}: ${error.message}`);
    backoffUntil.set(name, Date.now() + startGraceMs);
  }
}

async function reconcile() {
  await Promise.all(
    services.map(async (service) => {
      const name = service.name || service.command;
      if (service.enabled === false) return;
      if (!service.health || !service.command) {
        log(`${name}: missing health or command; skipping`);
        return;
      }
      if (Date.now() < (backoffUntil.get(name) || 0)) return;
      if (await isHealthy(service.health)) {
        if (children.has(name)) log(`${name} is healthy again`);
        return;
      }
      const spawnedAt = lastSpawn.get(name) || 0;
      if (Date.now() - spawnedAt < startGraceMs) return;
      spawnService(service);
      backoffUntil.set(name, Date.now() + startGraceMs);
    }),
  );
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (IS_WIN) {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      return;
    } catch {
      // fall through to SIGTERM
    }
  }
  try {
    child.kill('SIGTERM');
  } catch {
    // already gone
  }
}

let reconcileTimer = null;
let keepAliveTimer = null;

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  if (reconcileTimer) clearInterval(reconcileTimer);
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  for (const child of children.values()) killTree(child);
  if (FORWARD_ARGS.length) killTree(appChild);
  releaseLock();
  // Forced process.exit() can trip a libuv assertion on Windows; let handles drain.
  process.exitCode = code;
}

process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));

let appChild = null;

if (CHECK_ONLY) {
  if (!services.length) {
    log('no services configured (set DEV_SERVICES_JSON)');
  } else {
    for (const service of services) {
      const name = service.name || service.command;
      const enabled = service.enabled !== false;
      const healthy = service.health ? await isHealthy(service.health) : false;
      const serves = Array.isArray(service.serves) && service.serves.length
        ? ` serves=${service.serves.join(',')}`
        : '';
      log(`${name}: ${healthy ? 'UP' : 'DOWN'} (enabled=${enabled}${serves})`);
    }
  }
  // Let in-flight fetch handles drain; a forced process.exit() can trip a libuv
  // assertion on Windows.
  process.exitCode = 0;
}

if (!CHECK_ONLY) {
if (!services.length) {
  log('no services configured (set DEV_SERVICES_JSON); starting the command as-is');
}

// Reconcile once immediately, then on an interval.
await reconcile();
reconcileTimer = setInterval(() => {
  if (!stopping) void reconcile();
}, intervalMs);
reconcileTimer.unref();

if (FORWARD_ARGS.length) {
  const [command, ...args] = FORWARD_ARGS;
  log(`starting ${FORWARD_ARGS.join(' ')}`);
  appChild = spawn(command, args, { cwd: ROOT, stdio: 'inherit', shell: IS_WIN });
  appChild.once('exit', (code, signal) => {
    log(`app exited (code=${code ?? 'null'} signal=${signal ?? 'null'}); stopping services`);
    shutdown(typeof code === 'number' ? code : 0);
  });
} else {
  // Standalone mode: keep the supervisor alive until signalled.
  keepAliveTimer = setInterval(() => undefined, 60_000);
}
}
