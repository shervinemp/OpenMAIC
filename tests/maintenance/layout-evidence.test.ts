import { describe, expect, it } from 'vitest';

import {
  isLayoutEvidenceFresh,
  LAYOUT_EVIDENCE_MAX_AGE_MS,
} from '@/lib/maintenance/layout-relayout';

const NOW = 1_800_000_000_000; // post-CONTENT_AUDIT_EPOCH_MS era
const green = (checkedAt: number) => ({ errors: 0, warnings: 0, checkedAt });
const sceneWith = (layoutStatus: unknown, updatedAt: number) => ({ updatedAt, layoutStatus });

describe('isLayoutEvidenceFresh', () => {
  it('is fresh when green evidence is newer than the scene and within the cap', () => {
    expect(isLayoutEvidenceFresh(sceneWith(green(NOW - 1_000), NOW - 2_000), NOW)).toBe(true);
  });

  it('is not fresh without a ledger (never inspected)', () => {
    expect(isLayoutEvidenceFresh({ updatedAt: NOW - 10 }, NOW)).toBe(false);
    expect(isLayoutEvidenceFresh(sceneWith(undefined, NOW - 10), NOW)).toBe(false);
  });

  it('is not fresh when debt remains', () => {
    expect(
      isLayoutEvidenceFresh(
        sceneWith({ errors: 2, warnings: 0, checkedAt: NOW - 1 }, NOW - 5),
        NOW,
      ),
    ).toBe(false);
  });

  it('is not fresh when the scene changed after the check', () => {
    expect(isLayoutEvidenceFresh(sceneWith(green(NOW - 5_000), NOW - 1_000), NOW)).toBe(false);
  });

  it('is not fresh when the evidence is older than the age cap', () => {
    expect(
      isLayoutEvidenceFresh(
        sceneWith(
          green(NOW - LAYOUT_EVIDENCE_MAX_AGE_MS - 1),
          NOW - LAYOUT_EVIDENCE_MAX_AGE_MS - 2,
        ),
        NOW,
      ),
    ).toBe(false);
  });

  it('respects a caller-supplied cap', () => {
    expect(isLayoutEvidenceFresh(sceneWith(green(NOW - 10), NOW - 20), NOW, 5)).toBe(false);
    expect(isLayoutEvidenceFresh(sceneWith(green(NOW - 10), NOW - 20), NOW, 60)).toBe(true);
  });
});
