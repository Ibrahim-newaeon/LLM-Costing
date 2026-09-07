// /packages/contracts/scripts/generate-schemas.ts
//
// §A2 — Zod is canonical; /schemas/*.json are GENERATED. CI fails on drift.
// "Keep them in sync" is how they drift; a red build is how they don't.
//
//   pnpm tsx scripts/generate-schemas.ts            # write
//   pnpm tsx scripts/generate-schemas.ts --check    # verify, exit 1 on drift (CI)

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodTypeAny } from 'zod';

import { Registry, ModelRow } from '../src/registry';
import { VisionProfile } from '../src/vision';
import { Provenance } from '../src/provenance';

const OUT_DIR = join(__dirname, '..', '..', '..', 'schemas');

const TARGETS: Array<{ file: string; schema: ZodTypeAny; name: string }> = [
  { file: 'registry.schema.json', schema: Registry, name: 'Registry' },
  { file: 'model-row.schema.json', schema: ModelRow, name: 'ModelRow' },
  { file: 'vision-profile.schema.json', schema: VisionProfile, name: 'VisionProfile' },
  { file: 'provenance.schema.json', schema: Provenance, name: 'Provenance' },
];

const BANNER =
  'GENERATED from /packages/contracts/src — do not hand-edit. ' +
  'Run `pnpm generate:schemas`. CI fails if this file differs from the regenerated output (§A2).';

function render(schema: ZodTypeAny, name: string): string {
  const json = zodToJsonSchema(schema, {
    name,
    $refStrategy: 'root',
    target: 'jsonSchema2020-12',
  }) as Record<string, unknown>;
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
