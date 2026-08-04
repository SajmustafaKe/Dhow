import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
    ],
  },
  {
    // Code in transit from apps/dhow, which extends only
    // "next/core-web-vitals" and therefore never enforced any TypeScript
    // rules. Across the whole ported surface that is ~107 explicit `any`,
    // a handful of `let`s that should be `const`, and two
    // non-null-asserted optional chains.
    //
    // Those need fixing, but NOT while the code is being moved. The port's
    // safety property is that files arrive byte-identical wherever a version
    // bump did not force a change, so the 863 tests that came with them are a
    // real check on the move. Retyping at the same time makes every diff
    // change for two reasons at once and turns "did the port break anything?"
    // into a question nobody can answer.
    //
    // Everything listed here came from apps/dhow. Code written natively for
    // dhowx is re-strictened in the block below and stays at "error".
    //
    // Run `--fix` over these paths and clear the `any` backlog the day
    // apps/dhow is deleted; that is a reviewable change on its own.
    files: [
      "src/**", "di/**", "lib/**",
      "app/lib/**", "app/api/**", "app/actions/**", "app/components/**",
      "app/projects/**", "app/billing/**", "app/onboarding/**",
      "app/scripts/**", "app/composio/**", "app/providers/**", "app/styles/**",
      "components/common/**",
      "app/app.tsx", "app/loading.tsx", "app/new-chat-link.tsx",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "prefer-const": "warn",
      "@typescript-eslint/no-non-null-asserted-optional-chain": "warn",
      "@typescript-eslint/no-empty-object-type": "warn",
    },
  },
  {
    // Written for dhowx, not inherited. Held to the stricter standard that is
    // part of why dhowx is the trunk. Listed last so it wins over the transit
    // globs above where they overlap (app/api/v1/config, app/api/health).
    files: [
      "components/ui/**", "components/ai-elements/**",
      "app/(marketing)/**", "app/auth/**", "app/demo/**",
      "app/api/v1/config/**", "app/api/health/**",
      "app/layout.tsx", "middleware.ts",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "prefer-const": "error",
      "@typescript-eslint/no-non-null-asserted-optional-chain": "error",
      "@typescript-eslint/no-empty-object-type": "error",
    },
  },
];

export default eslintConfig;
