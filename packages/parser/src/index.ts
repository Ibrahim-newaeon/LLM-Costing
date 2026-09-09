// /packages/parser/src/index.ts
//
// §A4.4 Layer 0 — the front door.
//
// Everything in §A5 assumes a structured task graph already exists. This package
// builds it from a sentence a human typed, in English, Arabic or Chinese.
//
//   normalize.ts   §A4.4.2  strip, fold, westernize numerals, script PROPORTIONS
//   lexicon.ts     §A4.4.3  verb -> task SEQUENCE, negation, longest match
//   quantities.ts  §A4.4.3  volume, measure words, conditionals, doc class, scans
//   defaults.ts    §A4.4.4  guess quantities, never rates — and never over a measurement
//   parse.ts       §A4.4.1  L1, the confidence floor, and when to escalate
//
// Pure: no I/O, no clock, no network. L2 is an LLM call and is NOT implemented
// here — what is implemented is the decision to make one, which is the part that
// costs money and the part §A4.4.1 says a cost calculator must meter about itself.

export * from './normalize';
export * from './lexicon';
export * from './quantities';
export * from './defaults';
export * from './parse';
