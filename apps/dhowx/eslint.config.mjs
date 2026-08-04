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
    // rules. It carries 238 explicit `any` across 58 files.
    //
    // Those need fixing, but NOT while the code is being moved. The port's
    // whole safety property is that files arrive byte-identical, so the 852
    // tests that come with them are a real check on the move. Retyping at the
    // same time makes every diff change for two reasons at once and turns
    // "did the port break anything?" into a question nobody can answer.
    //
    // So: warn here, error everywhere else. New dhowx code — components,
    // marketing, anything outside these paths — stays strict. Raise this back
    // to "error" and clear the backlog once the last slice has landed and
    // apps/dhow is deleted.
    files: ["src/**", "app/lib/**", "app/api/**", "app/actions/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      // Same reasoning, same deal. 12 occurrences, all trivially auto-fixable
      // with --fix, and every one of them a genuine improvement. But applying
      // it now breaks byte-identity with apps/dhow for no behavioural gain,
      // and byte-identity is what makes the 850 carried tests a real check on
      // the move. Run --fix over these paths the day apps/dhow is deleted.
      "prefer-const": "warn",
    },
  },
];

export default eslintConfig;
