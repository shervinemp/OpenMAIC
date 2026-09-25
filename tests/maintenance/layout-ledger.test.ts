import { describe, expect, it } from 'vitest';
import {
  applyLayoutLedger,
  layoutLedgerOf,
} from '@/lib/maintenance/layout-relayout';

function overlappingScene(): { type: string; content: unknown } {
  return {
    type: 'slide',
    content: {
      type: 'slide',
      canvas: {
        viewportSize: 1000,
        viewportRatio: 0.5625,
        elements: [
          { id: 'a', type: 'text', left: 0, top: 0, width: 200, height: 50, role: 'primary' },
          { id: 'b', type: 'text', left: 40, top: 10, width: 200, height: 50, role: 'primary' },
        ],
      },
    },
  };
}

describe('layout-debt ledger', () => {
  it('count residuals: error occlusion betrays debt', () => {
    const scene = overlappingScene() as never as { content?: unknown };
    const status = applyLayoutLedger(scene, [
      { kind: 'occlusion', severity: 'error', message: 'x', elementId: 'b', elementIndex: 1 },
      { kind: 'occlusion', severity: 'warn', message: 'y', elementId: 'a', elementIndex: 0 },
    ]);
    expect(status.errors).toBe(1);
    expect(status.warnings).toBe(1);
    expect(layoutLedgerOf(scene)?.errors).toBe(1);
  });

  it('write-off: zero errors is the green state', () => {
    const scene = overlappingScene() as never as { content?: unknown };
    const status = applyLayoutLedger(scene, [
      { kind: 'occlusion', severity: 'warn', message: 'y', elementId: 'a', elementIndex: 0 },
    ]);
    expect(status.errors).toBe(0);
    expect(layoutLedgerOf(scene)).toMatchObject({ errors: 0, warnings: 1 });
  });

  it('rejects malformed ledger reads (deterministic truth only)', () => {
    expect(layoutLedgerOf({})).toBeNull();
    expect(layoutLedgerOf({ layoutStatus: { errors: 'x', warnings: 0, checkedAt: 1 } })).toBeNull();
    expect(layoutLedgerOf({ layoutStatus: null })).toBeNull();
    expect(layoutLedgerOf(null)).toBeNull();
  });
});
