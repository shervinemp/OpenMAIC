import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Gate for the course-maintenance routes (`/api/course-maintenance/*`): the
 * caller must present the dev persistence token as a bearer credential. The
 * routes read and rewrite stored courses in place, so a deployment without the
 * token configured refuses every request rather than leaving them open.
 *
 * The comparison is over fixed-length digests, so it takes the same time
 * wherever the two strings first differ.
 */
export function isMaintenanceUnauthorized(request: { headers: Headers }): boolean {
  const token = process.env.PERSISTENCE_DEV_TOKEN;
  const authorization = request.headers.get('authorization');
  if (!token || !authorization) return true;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return !timingSafeEqual(digest(authorization), digest(`Bearer ${token}`));
}
