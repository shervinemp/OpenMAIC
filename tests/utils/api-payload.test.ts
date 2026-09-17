import { describe, expect, it } from 'vitest';

import { readApiPayload } from '@/lib/utils/api-payload';

describe('readApiPayload', () => {
  it('reads a flat apiSuccess body', () => {
    const payload = readApiPayload<{ scans?: number }>({ success: true, scans: 7 });
    expect(payload?.scans).toBe(7);
  });

  it('returns null for error bodies', () => {
    const payload = readApiPayload({ success: false, error: 'nope' });
    expect(payload).toBeNull();
  });

  it('returns null for malformed bodies', () => {
    expect(readApiPayload(null)).toBeNull();
    expect(readApiPayload('text')).toBeNull();
    expect(readApiPayload(undefined)).toBeNull();
  });
});
