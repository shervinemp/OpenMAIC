/**
 * Operator configuration for the server-backed activity runtime.
 *
 * This tier executes arbitrary shell commands for cybersec/network labs, so it
 * is OFF unless an operator explicitly sets both the enable flag and an image
 * they built and reviewed. Every limit here is a bound on what one request can
 * spend or produce; none of them are learner-tunable.
 */

export const SERVER_ACTIVITY_ENABLE_ENV = 'ACTIVITY_SERVER_RUNTIME_ENABLED';
export const SERVER_ACTIVITY_IMAGE_ENV = 'ACTIVITY_DOCKER_IMAGE';
export const SERVER_ACTIVITY_DOCKER_BIN_ENV = 'ACTIVITY_DOCKER_BIN';

export interface ServerActivityRuntimeConfig {
  /** Effective gate: the flag must be true AND an image must be configured. */
  enabled: boolean;
  image: string;
  dockerBin: string;
  /** Wall-clock cap for one session, including container start-up. */
  timeoutMs: number;
  /** Process-wide concurrent containers. */
  maxConcurrency: number;
  maxCommands: number;
  /** Total characters across all commands. */
  maxCommandChars: number;
  maxFiles: number;
  /** Total bytes of seeded file content. */
  maxFileBytes: number;
  /** Captured stdout + stderr before the run is rejected. */
  maxOutputChars: number;
}

function boundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

export function readServerActivityRuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ServerActivityRuntimeConfig {
  const flag = env[SERVER_ACTIVITY_ENABLE_ENV]?.trim().toLowerCase() === 'true';
  const image = env[SERVER_ACTIVITY_IMAGE_ENV]?.trim() ?? '';
  return {
    enabled: flag && image !== '',
    image,
    dockerBin: env[SERVER_ACTIVITY_DOCKER_BIN_ENV]?.trim() || env.DOCKER_BIN?.trim() || 'docker',
    timeoutMs: boundedInt(env.ACTIVITY_SERVER_TIMEOUT_MS, 30_000, 5_000, 60_000),
    maxConcurrency: boundedInt(env.ACTIVITY_SERVER_MAX_CONCURRENCY, 2, 1, 8),
    maxCommands: boundedInt(env.ACTIVITY_SERVER_MAX_COMMANDS, 200, 1, 500),
    maxCommandChars: boundedInt(env.ACTIVITY_SERVER_MAX_COMMAND_CHARS, 100_000, 1_000, 500_000),
    maxFiles: boundedInt(env.ACTIVITY_SERVER_MAX_FILES, 50, 0, 200),
    maxFileBytes: boundedInt(env.ACTIVITY_SERVER_MAX_FILE_BYTES, 262_144, 1_024, 2_097_152),
    maxOutputChars: boundedInt(env.ACTIVITY_SERVER_MAX_OUTPUT_CHARS, 524_288, 4_096, 2_097_152),
  };
}
