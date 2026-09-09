// /packages/calibrate/src/index.ts
//
// §A5.4 output-prior capture. Pure and keyless: an integration that made a real
// API call hands over the response body; this package turns it into an
// `OutputSample` and, given enough samples, into an `OutputPrior` the estimator
// will price with instead of refusing.
//
//   sampleFromResponse    response body → OutputSample        (capture.ts; per-provider adapters in usage.ts)
//   buildOutputPriors     OutputSample[] → OutputPrior[]      (priors.ts; nearest-rank p50/p90, LOW below min_samples)
//
// Nothing here calls a provider. The samples file is the only thing a key ever
// touches, and it is produced outside this repo.

export * from './usage';
export * from './capture';
export * from './priors';
