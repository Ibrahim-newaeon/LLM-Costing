// /packages/ingest/src/queue.ts
//
// The conflict queue SPEC §A9's admin surface asks for: every unresolved
// disagreement in the registry, wherever it sits. Two kinds, because the
// contracts have two homes for rule 5 — `RateConflict` on a `Rate`, and
// `SourcedConflict` on any `sourced()` constant — and a queue that listed only
// one would leave the other invisible, which is the state finding 3.15 described.
//
// This is also the READER for `sourced().conflict`. A slot nothing reads is the
// defect this project keeps finding; the queue is what reads it.

import type { RateConflict, Registry, SourcedConflict } from '@tokenomics/contracts';

export type QueueEntry =
  | { model_id: string; path: string; kind: 'RATE'; conflict: RateConflict }
  | { model_id: string; path: string; kind: 'CONSTANT'; conflict: SourcedConflict };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Every unresolved conflict on every row. Walks the row as data: a `Rate` is any
 * object with `amount` and `provenance`; a sourced constant is any object with
 * `value` and `provenance`. Both are recognised by shape rather than by path so a
 * profile added to `ModelRow` later is covered without this file knowing about it.
 */
export function openConflicts(registry: Registry): QueueEntry[] {
  const out: QueueEntry[] = [];
  for (const row of registry.models) walk(row, row.model_id, '', out);
  return out;
}

function walk(node: unknown, model_id: string, path: string, out: QueueEntry[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => walk(item, model_id, `${path}[${i}]`, out));
    return;
  }
  if (!isRecord(node)) return;

  if ('provenance' in node && 'conflict' in node && isRecord(node.conflict) && node.conflict.resolved !== true) {
    if ('amount' in node) {
      out.push({ model_id, path, kind: 'RATE', conflict: node.conflict as RateConflict });
    } else if ('value' in node) {
      out.push({ model_id, path, kind: 'CONSTANT', conflict: node.conflict as SourcedConflict });
    }
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === 'conflict' || k === 'provenance') continue;
    walk(v, model_id, path ? `${path}.${k}` : k, out);
  }
}
