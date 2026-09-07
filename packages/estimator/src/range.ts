// /packages/estimator/src/range.ts

import type { Range } from '@tokenomics/contracts';

/**
 * Rule 3 says ranges, not points — for anything NON-DETERMINISTIC. Some
 * quantities are deterministic, and dressing those as a band would be its own
 * kind of dishonesty: it implies a spread that does not exist.
 *
 * Vision geometry is the clearest case. Given the dimensions and the provider's
 * constants, the tile count is arithmetic — run it twice and you get the same
 * integer. What is uncertain there is whether the CONSTANTS are right, and that
 * uncertainty is already carried by `method` + `confidence`. Widening p90 would
 * express it in the wrong place and let a MEDIUM-confidence exact count look like
 * a HIGH-confidence estimate with a wide band.
 *
 * So: exact quantities get a degenerate range, and their uncertainty stays on the
 * provenance where a reader can see what kind it is.
 */
export const exactRange = (n: number): Range => ({ p50: n, p90: n, p99: null });

/** True when a range carries no spread — i.e. it came from arithmetic. */
export const isExact = (r: Range): boolean => r.p50 === r.p90;
