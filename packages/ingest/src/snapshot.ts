// /packages/ingest/src/snapshot.ts
//
// §A4.2 — every pull writes a new immutable Snapshot. This is the only function
// that makes one, so the id format and the hash live in exactly one place.

import { createHash } from 'node:crypto';
import { Snapshot, type SourceClass } from '@tokenomics/contracts';
import type { FetchPort } from './port';

/** Where a source lives and what it is. The caller supplies it; nothing is hardcoded here. */
export interface SourceSpec {
  source_id: string;
  source_class: SourceClass;
  source_url: string;
}

export type SnapshotResult =
  | { status: 'OK'; snapshot: Snapshot; body: string }
  | { status: 'FAILED'; reason: string; http_status: number | null };

/**
 * Pull the source once and record what came back.
 *
 * `now` is injected: the retrieval time is part of the record, and a clock read
 * inside this function would make the same pull unreproducible in a test. A
 * non-2xx leaves NO snapshot — "we received a 503" is a fact about the fetch, not
 * about the prices, and recording it as a snapshot with an empty body would let a
 * later diff read every model as REMOVED.
 */
export async function takeSnapshot(
  port: FetchPort,
  source: SourceSpec,
  now: Date,
): Promise<SnapshotResult> {
  let res;
  try {
    res = await port({ url: source.source_url });
  } catch (e) {
    return { status: 'FAILED', reason: `fetch threw: ${(e as Error).message}`, http_status: null };
  }
  if (res.status < 200 || res.status >= 300) {
    return { status: 'FAILED', reason: `HTTP ${res.status} from ${source.source_url}`, http_status: res.status };
  }
  const retrieved_at = now.toISOString();
  const snapshot = Snapshot.parse({
    snapshot_id: `${source.source_id}@${retrieved_at}`,
    source_id: source.source_id,
    source_class: source.source_class,
    source_url: source.source_url,
    retrieved_at,
    content_sha256: createHash('sha256').update(res.text, 'utf8').digest('hex'),
    byte_length: Buffer.byteLength(res.text, 'utf8'),
  });
  return { status: 'OK', snapshot, body: res.text };
}

/**
 * "Unchanged since" — the honest name for what the prototype's refresh script
 * called `verified` (docs/prototype-salvage.md §2). Same bytes, same source: the
 * feed did not move. Says nothing about whether any figure in it is right.
 */
export const unchangedSince = (a: Snapshot, b: Snapshot): boolean =>
  a.source_url === b.source_url && a.content_sha256 === b.content_sha256;
