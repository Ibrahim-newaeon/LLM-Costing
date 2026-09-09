// /packages/ingest/src/index.ts
//
// §A4.2 / §A6 — pricing ingestion. The second package allowed I/O (port.ts);
// everything else here is pure and takes the fetched body as an argument.
//
//   takeSnapshot     pull a source once, record hash + time      (I/O, via a port)
//   extractLiteLLM   feed body → Observations for mapped models  (pure)
//   compareRates     Observations vs a registry row → outcomes   (pure; rule 5)
//   diffObservations two pulls of one source → PriceChangeEvents (pure)
//   applyConflicts   CONFLICT outcomes → registry with slots set (pure)
//   openConflicts    the review queue, both kinds of conflict    (pure)
//
// Build order (README): contracts → estimator → tokenizers → ingestion → registry →
// router → UI. This is the "ingestion" box.

export * from './port';
export * from './snapshot';
export * from './litellm';
export * from './locate';
export * from './compare';
export * from './diff';
export * from './apply';
export * from './queue';
