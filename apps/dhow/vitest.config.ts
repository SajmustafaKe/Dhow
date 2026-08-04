import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * apps/dhow shipped with no test runner and 0 tests across 457 files.
 *
 * This exists for characterization tests ahead of the port into apps/dhowx:
 * moving ~45k LOC between apps is a rewrite you cannot diff, and typecheck and
 * lint only catch type-level breakage. The tests here pin *current observable
 * behaviour* — not intended behaviour — so a port that changes it has to change
 * a test too, deliberately.
 *
 * `vite-tsconfig-paths` is required: source uses the `@/*` alias from
 * tsconfig.json everywhere, and Vitest does not read tsconfig paths on its own.
 *
 * Shape follows apps/x/packages/core/vitest.config.ts, the existing convention
 * in this repo.
 */
export default defineConfig({
    plugins: [tsconfigPaths()],
    test: {
        environment: "node",
        include: ["src/**/*.test.ts", "app/**/*.test.ts"],
        globals: false,
        clearMocks: true,
        restoreMocks: true,
    },
});
