// /packages/ingest/scripts/ingest-litellm.ts
//
// §A4.2 Tier A, run for real. Pulls LiteLLM's feed (or reads a saved body),
// compares it to /registry/registry.json, and prints what it found. Writes
// nothing unless told to, and what it writes is only ever a `conflict` slot —
// the registry figure is never changed by this script.
//
//   pnpm -F @tokenomics/ingest ingest:litellm --tolerance-pct 2
//   pnpm -F @tokenomics/ingest ingest:litellm --tolerance-pct 2 --offline /tmp/litellm.json
//   ... --previous registry/sources/litellm.observations.json   # diff against last run
//   ... --save-observations registry/sources/litellm.observations.json
//   ... --write                                                  # apply CONFLICTs to registry.json
//
// `--tolerance-pct` is required. §A3 names PRICE_CONFLICT_TOLERANCE_PCT and gives
// it no value, so the operator supplies one per run rather than inheriting a
// default nobody chose.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Observation, Registry, type Snapshot } from '@tokenomics/contracts';
import {
  applyConflicts,
  compareRates,
  diffObservations,
  extractLiteLLM,
  fetchPort,
  fixturePort,
  LiteLLMKeyMap,
  openConflicts,
  takeSnapshot,
  type RateComparison,
} from '../src/index';

const ROOT = join(__dirname, '..', '..', '..');
const REGISTRY = join(ROOT, 'registry', 'registry.json');
const SOURCE = join(ROOT, 'registry', 'sources', 'litellm.json');

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i === -1 || i + 1 >= process.argv.length ? null : process.argv[i + 1]!;
}
/** A path argument, relative to where `pnpm` was invoked — not to packages/ingest, where pnpm -F runs this. */
const pathArg = (name: string): string | null => {
  const v = arg(name);
  return v === null ? null : resolve(process.env.INIT_CWD ?? process.cwd(), v);
};
const flag = (name: string): boolean => process.argv.includes(name);

async function main(): Promise<number> {
  const toleranceArg = arg('--tolerance-pct');
  if (toleranceArg === null) {
    console.error('--tolerance-pct is required (PRICE_CONFLICT_TOLERANCE_PCT has no default; §A3 rule 5).');
    return 2;
  }
  const tolerance_pct = Number(toleranceArg);

  const source = JSON.parse(readFileSync(SOURCE, 'utf8'));
  const keys = LiteLLMKeyMap.parse(source.keys);
  const spec = { source_id: source.source_id, source_class: source.source_class, source_url: source.source_url };
  const registry = Registry.parse(JSON.parse(readFileSync(REGISTRY, 'utf8')));

  const offline = pathArg('--offline');
  const port = offline ? fixturePort({ [spec.source_url]: readFileSync(offline, 'utf8') }) : fetchPort;
  const pulled = await takeSnapshot(port, spec, new Date());
  if (pulled.status !== 'OK') {
    console.error(`snapshot FAILED: ${pulled.reason}`);
    return 1;
  }
  const snapshot: Snapshot = pulled.snapshot;
  console.log(`snapshot ${snapshot.snapshot_id}${offline ? ' (offline body)' : ''}`);
  console.log(`  sha256 ${snapshot.content_sha256}  bytes ${snapshot.byte_length}`);

  const { observations, missing, malformed } = extractLiteLLM({ body: pulled.body, snapshot, keys, currency: source.currency.value });
  console.log(`  ${observations.length} observations for ${Object.keys(keys).length} mapped models; ${missing.length} missing, ${malformed.length} malformed`);
  for (const m of missing) console.log(`  MISSING   ${m.model_id} ← feed key "${m.key}" not present`);
  for (const m of malformed) console.log(`  MALFORMED ${m.model_id} ← "${m.key}": ${m.issue}`);

  const comparisons: RateComparison[] = registry.models.flatMap((row) => compareRates(row, observations, tolerance_pct));
  console.log(`\ncomparisons (tolerance ${tolerance_pct}%):`);
  for (const c of comparisons) {
    const key = `${c.key.direction}${c.key.modality ? `/${c.key.modality}` : ''}${c.key.above_tokens !== null ? ` >${c.key.above_tokens}` : ''}`;
    const reg = c.registry ? `${c.registry.amount} ${c.registry.unit}` : '—';
    const delta = c.delta_pct === null ? '' : ` (${c.delta_pct > 0 ? '+' : ''}${c.delta_pct}%)`;
    console.log(`  ${c.outcome.padEnd(18)} ${c.model_id.padEnd(16)} ${key.padEnd(22)} registry ${reg.padEnd(22)} feed ${c.observed.amount} ${c.observed.unit}${delta}`);
  }

  const leads = observations.filter((o) => o.kind !== 'RATE');
  if (leads.length) {
    console.log('\nnon-rate claims (for a human to check on the vendor page; never written):');
    for (const o of leads) {
      const what = o.kind === 'LIMIT' ? `${o.which} = ${o.value}` : `${o.which} = ${o.value}`;
      const row = registry.models.find((m) => m.model_id === o.model_id)!;
      const ours =
        o.kind === 'LIMIT' ? (o.which === 'context_window' ? row.context_window.value : row.max_output.value) : row.deprecation_date;
      console.log(`  ${o.model_id.padEnd(16)} feed says ${what.padEnd(34)} registry has ${ours ?? 'null'}`);
    }
  }

  const previousPath = pathArg('--previous');
  if (previousPath) {
    const previous = Observation.array().parse(JSON.parse(readFileSync(previousPath, 'utf8')));
    const events = diffObservations(previous, observations);
    console.log(`\nprice changes since ${previousPath}: ${events.length}`);
    for (const e of events) {
      console.log(`  ${e.change.padEnd(8)} ${e.model_id} ${e.key.direction}${e.key.above_tokens !== null ? ` >${e.key.above_tokens}` : ''}: ${e.previous_amount ?? '—'} → ${e.current_amount ?? '—'} ${e.unit}${e.delta_pct !== null ? ` (${e.delta_pct > 0 ? '+' : ''}${e.delta_pct}%)` : ''}`);
    }
  }

  const savePath = pathArg('--save-observations');
  if (savePath) {
    writeFileSync(savePath, JSON.stringify(observations, null, 2) + '\n');
    console.log(`\nsaved ${observations.length} observations to ${savePath}`);
  }

  const conflicts = comparisons.filter((c) => c.outcome === 'CONFLICT');
  if (flag('--write')) {
    const applied = applyConflicts(registry, comparisons);
    writeFileSync(REGISTRY, JSON.stringify(applied.registry, null, 2) + '\n');
    console.log(`\nwrote ${applied.applied.length} conflict slot(s) to registry.json; ${applied.unapplied.length} not applied`);
    for (const u of applied.unapplied) console.log(`  NOT APPLIED ${u.model_id} ${u.path}: ${u.reason}`);
    console.log(`open conflicts in the registry now: ${openConflicts(applied.registry).length}`);
  } else if (conflicts.length) {
    console.log(`\n${conflicts.length} CONFLICT(s) found; re-run with --write to record them on the registry rows (the rates themselves are not changed).`);
  }
  return conflicts.length ? 1 : 0;
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
