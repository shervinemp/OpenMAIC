import { it } from 'vitest';
import fs from 'node:fs';
import { residualFindings } from '@/lib/maintenance/layout-relayout';
import { computeSplitPlan, planSummary } from '@/lib/maintenance/split-plan';
import { layoutLedgerOf } from '@/lib/maintenance/layout-relayout';

it('scratch class breakdown', () => {
  const doc = JSON.parse(fs.readFileSync('.data/persistence/documents/2WjD3KDIez.json', 'utf8'));
  for (const id of ['0PkrGIovR5h7GxEXY4s7D__p2', 'iwOi-Aafr_mucZpyu2LY3__p3', '-ZVBCV11VWH26P4nZ5yL0']) {
    const s = doc.scenes.find((x: { id: string }) => x.id === id);
    if (!s) { console.log('===', id, 'NOT FOUND'); continue; }
    const els = s.content?.canvas?.elements || [];
    console.log('===', id, 'els', els.length, 'ledger', JSON.stringify(layoutLedgerOf(s)));
    for (const f of residualFindings(s)) console.log('   FIND:', f.severity, f.kind, (f as unknown as { elementId?: string }).elementId, '—', (f as unknown as { otherElementId?: string }).otherElementId);
    const plan = computeSplitPlan(s);
    console.log('    split:', plan ? planSummary(plan) : 'none', plan?.reason?.slice(0, 80));
    els.forEach((e: Record<string, unknown>, i: number) => console.log(
      `    ${i}: ${e.type} y=${e.top} h=${e.height} x=${e.left} w=${e.width} ${String(e.content ?? '').replace(/<[^>]+>/g, '').trim().slice(0, 36)}`
    ));
  }
});
