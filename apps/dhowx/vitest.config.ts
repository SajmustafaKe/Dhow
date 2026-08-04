import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * Mirrors apps/dhow/vitest.config.ts exactly.
 *
 * apps/dhow's product surface is being ported into this app, and its 852 tests
 * come with it. Any difference in runner config here would show up as tests
 * that pass in the source app and fail in the destination for reasons that have
 * nothing to do with the port.
 *
 * `vite-tsconfig-paths` is required: source uses the `@/*` alias from
 * tsconfig.json, and Vitest does not read tsconfig paths on its own.
 */
export default defineConfig({
    plugins: [tsconfigPaths()],
    test: {
        environment: "node",
        include: ["src/**/*.test.ts", "app/**/*.test.ts", "lib/**/*.test.ts"],
        globals: false,
        clearMocks: true,
        restoreMocks: true,
    },
});
