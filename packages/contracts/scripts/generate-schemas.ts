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

import { Registry, ModelRow } from '../src/registry';
import { VisionProfile } from '../src/vision';
import { Provenance } from '../src/provenance';
import { Assumption } from '../src/assumption';
import { WorkflowInput } from '../src/workflow';
import { EstimateOutput } from '../src/estimate';

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
  json.title = name;
  json.$comment = BANNER;
  return JSON.stringify(json, null, 2) + '\n';
}

function main(): void {
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
