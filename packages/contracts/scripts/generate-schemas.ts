// /packages/contracts/scripts/generate-schemas.ts
//
// §A2 — Zod is canonical; /schemas/*.json are GENERATED. CI fails on drift.
// "Keep them in sync" is how they drift; a red build is how they don't.
//
//   pnpm tsx scripts/generate-schemas.ts            # write
//   pnpm tsx scripts/generate-schemas.ts --check    # verify, exit 1 on drift (CI)
//
// 2026-09-07 — was `zod-to-json-schema`. On zod 4 that package does not throw; it
// emits `{}` for every object, so all four targets rendered as empty schemas and the
// gate would have gone green while guarding nothing. Replaced with zod 4's built-in
// `z.toJSONSchema`, which also removes the dependency.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { z } from 'zod';

import * as contracts from '../src/index';
import { Registry, ModelRow } from '../src/registry';
import { VisionProfile } from '../src/vision';
import { Provenance } from '../src/provenance';
import { Assumption } from '../src/assumption';
import { WorkflowInput } from '../src/workflow';
import { InstanceProfile } from '../src/instance';
import { EstimateOutput } from '../src/estimate';
import { TextCalibration, OutputPrior } from '../src/calibration';

const OUT_DIR = join(__dirname, '..', '..', '..', 'schemas');

const TARGETS: Array<{ file: string; schema: z.ZodType; name: string }> = [
  { file: 'registry.schema.json', schema: Registry, name: 'Registry' },
  { file: 'model-row.schema.json', schema: ModelRow, name: 'ModelRow' },
  { file: 'vision-profile.schema.json', schema: VisionProfile, name: 'VisionProfile' },
  { file: 'provenance.schema.json', schema: Provenance, name: 'Provenance' },
  { file: 'assumption.schema.json', schema: Assumption, name: 'Assumption' },
  // Overwrites a file that was hand-authored and orphaned. From here it is build
  // output: the gate guards a document the app actually reads.
  { file: 'workflow-input.schema.json', schema: WorkflowInput, name: 'WorkflowInput' },
  { file: 'estimate-output.schema.json', schema: EstimateOutput, name: 'EstimateOutput' },
  { file: 'text-calibration.schema.json', schema: TextCalibration, name: 'TextCalibration' },
  { file: 'output-prior.schema.json', schema: OutputPrior, name: 'OutputPrior' },
  // §A5.9 — the deployment economics the deleted pricing-record.schema.json
  // carried and nothing replaced. Ingestion writes these rows, so the drift gate
  // has to guard the document it validates them against.
  { file: 'instance-profile.schema.json', schema: InstanceProfile, name: 'InstanceProfile' },
];

const BANNER =
  'GENERATED from /packages/contracts/src — do not hand-edit. ' +
  'Run `pnpm generate:schemas`. CI fails if this file differs from the regenerated output (§A2).';

function render(schema: z.ZodType, name: string): string {
  // io: 'input' — these schemas validate documents as they arrive (a registry file,
  // an ingested pricing row), before Zod applies `.default()`. The contracts lean
  // heavily on defaults, so input and output shapes differ: under 'output' every
  // defaulted field would be reported as required, which is not what a source
  // document has to carry.
  //
  // unrepresentable is left at its default ('throw'): a shape JSON Schema cannot
  // express should fail the build, not be silently widened to `{}` — that is the
  // exact failure this file was rewritten to remove.
  const json = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: 'input',
    // reused: 'ref' — shared subschemas go to $defs instead of being inlined at every
    // use site. Without it Registry renders at ~429 KB of repeated copies, which no
    // reviewer can read a drift diff of.
    reused: 'ref',
  }) as Record<string, unknown>;
  inlineAnonymousDefs(json);
  json.title = name;
  json.$comment = BANNER;
  return JSON.stringify(json, null, 2) + '\n';
}

/**
 * Inline the leftovers that `nameTheDefs` could not name.
 *
 * Registering the exports names every def that corresponds to a real type, but zod
 * also extracts anonymous inline shapes it sees twice — a nullable string, a
 * defaulted boolean — and those keep positional `__schemaN` names. They are the
 * renumbering hazard and they buy nothing: measured across all seven targets they
 * run 2 to 385 bytes, median 74, so the `$ref` indirection costs about as much as
 * the body it replaces while making the file unreadable.
 *
 * Inlining them leaves `$defs` holding only the package's actual types. A reviewer
 * reading a drift diff then sees a change to `Provenance`, not to `__schema41`.
 *
 * Safe because no anonymous def references another — asserted below rather than
 * assumed, since if that ever stops holding this needs a fixpoint and a cycle
 * check, and silently producing a broken schema is the failure mode this whole
 * file exists to prevent.
 */
function inlineAnonymousDefs(json: Record<string, unknown>): void {
  const defs = json.$defs as Record<string, unknown> | undefined;
  if (!defs) return;

  const anonNames = Object.keys(defs).filter((k) => k.startsWith('__schema'));
  if (anonNames.length === 0) return;

  const bodies = new Map<string, unknown>();
  for (const k of anonNames) {
    bodies.set(k, defs[k]);
    delete defs[k];
  }

  // An anonymous def may reference another — an inline object whose fields are
  // themselves inline shapes. Resolve the bodies against each other to a fixpoint
  // first, so the main walk below is a single pass over already-flat bodies.
  //
  // Bounded, and it throws on a genuine cycle rather than looping or emitting
  // something half-substituted. A schema that cannot be flattened is a schema this
  // function does not understand, and guessing is how the empty-schema bug shipped.
  const MAX_PASSES = 32;
  for (let pass = 0; ; pass++) {
    if (pass >= MAX_PASSES) {
      throw new Error(
        'Anonymous defs did not reach a fixpoint after ' +
          `${MAX_PASSES} passes — they reference each other cyclically. Name the recursive shape ` +
          'by exporting it, so it becomes a real $def instead of an anonymous one.',
      );
    }
    let changed = false;
    for (const [name, body] of bodies) {
      const serialized = JSON.stringify(body);
      if (!serialized.includes('#/$defs/__schema')) continue;
      if (serialized.includes(`#/$defs/${name}"`)) {
        throw new Error(`Anonymous def ${name} references itself; it needs a name, not inlining.`);
      }
      bodies.set(name, substituteAnonRefs(body, bodies));
      changed = true;
    }
    if (!changed) break;
  }

  const walk = (node: unknown): unknown => substituteAnonRefs(node, bodies);

  // The root and the surviving named defs both need rewriting.
  for (const [k, v] of Object.entries(json)) {
    if (k !== '$defs') json[k] = walk(v);
  }
  for (const [k, v] of Object.entries(defs)) defs[k] = walk(v);

  if (Object.keys(defs).length === 0) delete json.$defs;
}

/** Replace every `$ref` to a body in `bodies` with an independent copy of it. */
function substituteAnonRefs(node: unknown, bodies: Map<string, unknown>): unknown {
  const walk = (n: unknown): unknown => {
    if (Array.isArray(n)) return n.map(walk);
    if (n === null || typeof n !== 'object') return n;

    const obj = n as Record<string, unknown>;
    const ref = obj.$ref;
    if (typeof ref === 'string') {
      const target = /^#\/\$defs\/(.+)$/.exec(ref)?.[1];
      if (target !== undefined && bodies.has(target)) {
        // structuredClone so each use site owns its copy and a later mutation of
        // one cannot travel to the others.
        const copy = structuredClone(bodies.get(target)) as Record<string, unknown>;
        const { $ref: _replaced, ...siblings } = obj;
        return Object.keys(siblings).length > 0 ? { ...copy, ...siblings } : copy;
      }
    }

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = walk(v);
    return out;
  };

  return walk(node);
}

/**
 * Give every extracted `$defs` entry a real name.
 *
 * `reused: 'ref'` is what keeps Registry at 81 KB instead of 429 KB, but zod names
 * an unregistered def POSITIONALLY — `__schema0`, `__schema1`, … — so inserting a
 * single field renumbers every def after it and a one-line change lands as a diff
 * nobody can review. A drift gate whose diffs are unreadable is a gate people
 * learn to rubber-stamp, which is worse than no gate: it launders changes.
 *
 * Registering each exported schema under its export name fixes both halves. The
 * defs get names, and the names are stable because they ARE the package's public
 * API — renaming an export renames its def, which is correct and reviewable.
 *
 * Done here rather than in the contract files so the source stays free of
 * registration noise; nothing about a schema's meaning depends on it.
 *
 * Iteration order is the module namespace's, which the spec sorts, so output is
 * deterministic — a requirement, not a nicety, for a byte-comparison gate.
 */
function nameTheDefs(): void {
  for (const [exportName, value] of Object.entries(contracts)) {
    if (value instanceof z.ZodType && z.globalRegistry.get(value) === undefined) {
      z.globalRegistry.add(value, { id: exportName });
    }
  }
}

function main(): void {
  nameTheDefs();
  const check = process.argv.includes('--check');
  const drift: string[] = [];

  for (const t of TARGETS) {
    const path = join(OUT_DIR, t.file);
    const next = render(t.schema, t.name);

    if (check) {
      if (!existsSync(path)) {
        drift.push(`${t.file}: missing — never generated`);
        continue;
      }
      if (readFileSync(path, 'utf8') !== next) drift.push(`${t.file}: differs from the Zod source`);
      continue;
    }

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, next);
    console.log(`wrote ${t.file}`);
  }

  if (check) {
    if (drift.length > 0) {
      console.error('\nSchema drift detected. /schemas/*.json is generated, not authored.\n');
      for (const d of drift) console.error(`  ✗ ${d}`);
      console.error('\nFix: pnpm generate:schemas, then commit the result.\n');
      process.exit(1);
    }
    console.log('schemas in sync with Zod ✓');
  }
}

main();
