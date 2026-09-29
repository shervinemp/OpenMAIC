import { afterEach, describe, expect, it, vi } from 'vitest';

import { isMaintenanceUnauthorized } from '@/lib/server/maintenance-auth';

const request = (authorization?: string) => ({
  headers: new Headers(authorization ? { authorization } : {}),
});

describe('isMaintenanceUnauthorized', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses every request while no token is configured', () => {
    vi.stubEnv('PERSISTENCE_DEV_TOKEN', '');
    expect(isMaintenanceUnauthorized(request('Bearer '))).toBe(true);
    expect(isMaintenanceUnauthorized(request())).toBe(true);
  });

  it('accepts exactly the configured bearer token', () => {
    vi.stubEnv('PERSISTENCE_DEV_TOKEN', 'secret-token');
    expect(isMaintenanceUnauthorized(request('Bearer secret-token'))).toBe(false);
  });

  it('refuses a missing, wrong, or differently-shaped credential', () => {
    vi.stubEnv('PERSISTENCE_DEV_TOKEN', 'secret-token');
    expect(isMaintenanceUnauthorized(request())).toBe(true);
    expect(isMaintenanceUnauthorized(request('Bearer secret-tokeN'))).toBe(true);
    expect(isMaintenanceUnauthorized(request('secret-token'))).toBe(true);
  });
});
