/**
 * App-side JSON parsing for the fork's routes and planners outside the
 * generation package: the package's implementation, bound to the app logger
 * so parse failures stay visible in server logs.
 */
import {
  parseJsonResponse as parseGenerationJsonResponse,
  tryParseJson as tryParseGenerationJson,
} from '@openmaic/generation';

import { createLogger } from '@/lib/logger';

const log = createLogger('Generation');

export function parseJsonResponse<T>(response: string): T | null {
  return parseGenerationJsonResponse<T>(response, { logger: log });
}

export function tryParseJson<T>(jsonStr: string): T | null {
  return tryParseGenerationJson<T>(jsonStr, { logger: log });
}
