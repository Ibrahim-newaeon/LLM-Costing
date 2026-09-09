// /packages/ingest/src/apply.ts
//
// Writing a CONFLICT onto the registry row it is about. Pure: takes a registry,
// returns a new one, and whether the result reaches disk is the runner's decision
// behind an explicit flag. The registry figure is never changed — only the
// `conflict` slot beside it is filled (rule 5).

import { Registry, type RateConflict } from '@tokenomics/contracts';
import { locateRate } from './locate';
import type { RateComparison } from './compare';

export interface ApplyResult {
  registry: Registry;
  applied: Array<{ model_id: string; path: string }>;
  /**
   * Conflicts that could not be written, and why. `RateConflict` holds ONE
   * competing record; a rate already carrying an unresolved conflict from a
   * different source keeps it, and the second is reported here rather than
   * overwriting the first — losing a disagreement is merging by another route.
   */
  unapplied: Array<{ model_id: string; path: string | null; reason: string }>;
}

export function applyConflicts(registry: Registry, comparisons: readonly RateComparison[]): ApplyResult {
  const next = structuredClone(registry);
  const result: ApplyResult = { registry: next, applied: [], unapplied: [] };

  for (const c of comparisons) {
    if (c.outcome !== 'CONFLICT' || c.conflict === null) continue;
    const row = next.models.find((m) => m.model_id === c.model_id);
    if (!row) {
      result.unapplied.push({ model_id: c.model_id, path: c.path, reason: 'row not in registry' });
      continue;
    }
    const located = locateRate(row, c.key);
    if (located.status !== 'FOUND') {
      result.unapplied.push({ model_id: c.model_id, path: c.path, reason: `rate not found on row: ${located.status}` });
      continue;
    }
    const existing: RateConflict | null = located.rate.conflict;
    if (existing !== null && !existing.resolved && existing.competing_source_url !== c.conflict.competing_source_url) {
      result.unapplied.push({
        model_id: c.model_id,
        path: located.path,
        reason: `slot holds an unresolved conflict with ${existing.competing_source_url}; not overwritten. Resolve that one first.`,
      });
      continue;
    }
    located.rate.conflict = c.conflict;
    result.applied.push({ model_id: c.model_id, path: located.path });
  }

  // The row still has to be a row. A conflict that makes the registry unparseable
  // is a bug here, and it should fail here.
  result.registry = Registry.parse(next);
  return result;
}
