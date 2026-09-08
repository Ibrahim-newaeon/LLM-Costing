// /packages/tokenizers/src/index.ts
//
// §A4.5's tier ladder, above the heuristic.
//
// This package is the ONLY one in the repo allowed to do I/O. `estimator` states in
// its own index that it has no I/O, no clock and no network, which is what makes an
// estimate reproducible from its arguments; tier 1 needs a network call, so the call
// lives here and the estimator receives a plain value.
//
//   tier 0  cache.ts      check before spending a call — keyed on (model, request)
//   tier 1  anthropic.ts  the provider's own count endpoint
//   tier 2  —             a local or proxy tokenizer. Not built, and for Anthropic
//                         it does not exist: the ladder runs 0 -> 1 -> 3 with no
//                         rung between the count endpoint and the heuristic.
//   tier 3  estimator/text.ts — the calibrated heuristic, and the only padded tier

export * from './port';
export * from './anthropic';
export * from './cache';
export * from './ladder';
