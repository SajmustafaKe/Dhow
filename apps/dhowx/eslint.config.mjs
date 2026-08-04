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
    // `_`-prefixed bindings are intentionally unused. Without this, the only
    // way to keep a positionally-required parameter, or a destructured key
    // held back from a `...rest` spread, is a `void x;` statement -- which
    // reads as dead code to the next person. Applies everywhere: this is a
    // naming convention, not a leniency about transit code.
    files: ["**/*.{ts,tsx,mts,cts}"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
        ignoreRestSiblings: true,
      }],
    },
  },
  {
    // One standard, everywhere.
    //
    // These four spent one commit as warnings while apps/dhow still existed.
    // The reason was narrow and is now spent: during the port, files arrived
    // byte-identical wherever a version bump did not force a change, and that
    // identity is what made the 863 carried tests a real check on the move.
    // Retyping mid-flight would have made every diff change for two reasons
    // at once and turned "did the port break anything?" into a question
    // nobody could answer.
    //
    // apps/dhow is deleted and the backlog is cleared -- 626 warnings to 0,
    // no `as any`, no `as unknown as`, no `@ts-ignore`, and zero
    // eslint-disable directives written to get there. Nothing is in transit,
    // so nothing gets an exemption. A path-scoped carve-out that outlives its
    // reason is just a place for the next backlog to accumulate unnoticed.
    files: ["**/*.{ts,tsx,mts,cts}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "prefer-const": "error",
      "@typescript-eslint/no-non-null-asserted-optional-chain": "error",
      "@typescript-eslint/no-empty-object-type": "error",
    },
  },
];

export default eslintConfig;
