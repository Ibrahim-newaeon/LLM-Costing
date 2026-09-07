// /packages/contracts/src/index.ts
//
// The single source of truth for every shape the engine passes around (§A2).
// registry.schema.ts and the Zod block in Annex A15 §11 are SUPERSEDED — delete
// them rather than syncing. Two definitions is how the drift this replaces began.

export * from './provenance';
export * from './assumption';
export * from './vision';
export * from './pricing';
export * from './registry';
export * from './workflow';
export * from './estimate';
