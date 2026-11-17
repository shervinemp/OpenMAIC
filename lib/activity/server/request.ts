/**
 * Request validation for the server activity runtime.
 *
 * The route only ever forwards this whitelisted shape to the sandbox image.
 * Anything else in the body (credentials, environment, mounts, image names) is
 * dropped rather than trusted.
 */
import type { ActivityRunRequest } from '../protocol';
import type { ServerActivityRuntimeConfig } from './config';

export interface ServerRunValidation {
  request?: ActivityRunRequest;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const INVALID_PATH_SEGMENTS = /(^|\/)\.\.?(\/|$)|\\/;

export function isSafeActivityPath(path: string): boolean {
  if (path.trim() === '' || path.startsWith('/')) return false;
  if (path.includes('\0') || path.includes('\\')) return false;
  if (INVALID_PATH_SEGMENTS.test(path)) return false;
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

export function validateServerActivityRunRequest(
  body: unknown,
  config: ServerActivityRuntimeConfig,
): ServerRunValidation {
  if (!isRecord(body)) return { error: 'Expected a JSON object.' };
  if (body.kind !== 'terminal')
    return { error: 'The server runtime only executes terminal activities.' };
  if (body.runtime !== 'server') {
    return { error: 'A server-runtime request must carry runtime: "server".' };
  }

  const commands = body.commands;
  if (!Array.isArray(commands)) return { error: '`commands` must be an array of strings.' };
  if (commands.length > config.maxCommands) {
    return { error: `A session may run at most ${config.maxCommands} commands.` };
  }
  let commandChars = 0;
  for (const command of commands) {
    if (typeof command !== 'string') return { error: 'Every command must be a string.' };
    if (command.includes('\0')) return { error: 'Commands may not contain NUL bytes.' };
    commandChars += command.length;
    if (commandChars > config.maxCommandChars) {
      return { error: `Commands may total at most ${config.maxCommandChars} characters.` };
    }
  }

  const initialFiles = body.initialFiles;
  if (initialFiles !== undefined && !isRecord(initialFiles)) {
    return { error: '`initialFiles` must be an object of path → text.' };
  }
  const files: Record<string, string> = {};
  let fileBytes = 0;
  if (initialFiles) {
    const entries = Object.entries(initialFiles);
    if (entries.length > config.maxFiles) {
      return { error: `A lab may seed at most ${config.maxFiles} files.` };
    }
    for (const [path, content] of entries) {
      if (!isSafeActivityPath(path))
        return { error: `Unsafe activity file path: ${JSON.stringify(path)}` };
      if (typeof content !== 'string')
        return { error: 'Every seeded file must have string content.' };
      fileBytes += Buffer.byteLength(path, 'utf8') + Buffer.byteLength(content, 'utf8');
      if (fileBytes > config.maxFileBytes) {
        return { error: `Seeded files may total at most ${config.maxFileBytes} bytes.` };
      }
      files[path] = content;
    }
  }

  const rawTimeLimit = typeof body.timeLimitMs === 'number' ? body.timeLimitMs : NaN;
  const timeLimitMs = Number.isFinite(rawTimeLimit)
    ? Math.min(Math.max(Math.round(rawTimeLimit), 1_000), config.timeoutMs)
    : config.timeoutMs;

  return {
    request: {
      kind: 'terminal',
      runtime: 'server',
      timeLimitMs,
      initialFiles: files,
      commands: commands as string[],
    },
  };
}
