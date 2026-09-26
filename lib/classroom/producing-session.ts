/**
 * Whether the agent session that produces a server-job course may still be
 * writing it.
 *
 * A server-job course is written by an agent runtime session (see
 * `DocumentProducer`), and the browser is an observer while that session
 * works: a repair pass writes narration ids and media references back into
 * the scenes, so running one alongside the agent races its document writes
 * (and may pay twice for clips the agent is still rendering). Once the
 * session has finished — succeeded, failed or cancelled — the course is as
 * settled as any client-authored one, and its decayed bytes are the owner's
 * to repair.
 *
 * Fails closed: when the answer cannot be had, the session is treated as
 * active and the repair waits for a later run. A deployment without the agent
 * runtime (404) has no session that could be producing anything.
 */

const ACTIVE_STATUSES = new Set(['queued', 'running']);

export async function isProducingSessionActive(
  producerRef: string | null | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  let response: Response;
  try {
    response = await fetchImpl('/api/agent/sessions/status', { cache: 'no-store' });
  } catch {
    return true;
  }
  if (response.status === 404) return false;
  if (!response.ok) return true;
  let statuses: Record<string, unknown>;
  try {
    statuses = (await response.json()) as Record<string, unknown>;
  } catch {
    return true;
  }
  if (!statuses || typeof statuses !== 'object') return true;
  // Without a handle to the producing session, any live session of this owner
  // may be the one writing the course.
  if (!producerRef) {
    return Object.values(statuses).some((status) => ACTIVE_STATUSES.has(String(status)));
  }
  return ACTIVE_STATUSES.has(String(statuses[producerRef]));
}
