// /packages/calibrate/scripts/build-priors.ts
//
// §A5.4 — turn a file of captured OutputSamples into the OutputPrior table the
// estimator prices with. No network, no key: the samples were captured by an
// integration that made the calls; this only reads the file it wrote.
//
//   pnpm -F @tokenomics/calibrate build:priors --samples <file> --min-samples 200 [--out registry/priors/output.priors.json]
//
// `--min-samples` is required. §A4.1 uses 200 for the text corpus buckets and
// states no figure for output priors, so the operator chooses one per run rather
// than inheriting a number the spec did not give this table.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { OutputSample } from '@tokenomics/contracts';
import { buildOutputPriors } from '../src/index';

const ROOT = join(__dirname, '..', '..', '..');
const DEFAULT_OUT = join(ROOT, 'registry', 'priors', 'output.priors.json');

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i === -1 || i + 1 >= process.argv.length ? null : process.argv[i + 1]!;
}
/** pnpm -F runs in the package dir; paths the operator typed are relative to where they typed them. */
const pathArg = (name: string): string | null => {
  const v = arg(name);
  return v === null ? null : resolve(process.env.INIT_CWD ?? process.cwd(), v);
};

function main(): number {
  const samplesPath = pathArg('--samples');
  const minArg = arg('--min-samples');
  if (samplesPath === null || minArg === null) {
    console.error('usage: build:priors --samples <file> --min-samples <n> [--out <file>]');
    return 2;
  }
  const min_samples = Number(minArg);
  const out = pathArg('--out') ?? DEFAULT_OUT;

  const samples = OutputSample.array().parse(JSON.parse(readFileSync(samplesPath, 'utf8')));
  const now = new Date().toISOString();
  const result = buildOutputPriors(samples, { min_samples, now });

  console.log(`${samples.length} sample(s) read from ${samplesPath}; ${result.duplicates} duplicate(s) set aside`);
  for (const p of result.priors) {
    const r = p.reasoning_tokens ? `reasoning p50 ${p.reasoning_tokens.p50} p90 ${p.reasoning_tokens.p90}` : 'reasoning: none reported';
    console.log(`  ${p.provenance.confidence.padEnd(6)} ${p.model_id.padEnd(16)} ${p.band.padEnd(9)} n=${String(p.n_samples).padEnd(5)} visible p50 ${p.output_tokens.p50} p90 ${p.output_tokens.p90}; ${r}`);
  }
  for (const w of result.warnings) console.log(`  WARN    ${w.message}`);
  for (const r of result.refused) console.log(`  REFUSED ${r.model_id} "${r.band}": ${r.reason}`);

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    JSON.stringify({ generated_at: now, min_samples, samples_file: samplesPath, priors: result.priors, warnings: result.warnings, refused: result.refused }, null, 2) + '\n',
  );
  console.log(`\nwrote ${result.priors.length} prior(s) to ${out}`);
  return 0;
}

process.exit(main());
