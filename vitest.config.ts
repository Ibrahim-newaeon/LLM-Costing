// Root test runner for the whole workspace.
//
// One vitest, one config, every package. Per-package vitest installs were the
// alternative and they broke: pnpm 12 recorded a peerless `vitest@5.0.0` for
// packages/estimator while only materializing the peer-resolved variant, so the
// symlink dangled on a clean install. Reproducible, and it would have failed in
// CI identically.
//
// Consolidating here fixes that by construction and removes the duplicated dev
// dependency. `pnpm test` runs everything; `pnpm vitest run packages/estimator`
// narrows it.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
  },
});
