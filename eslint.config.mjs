import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import reactCompiler from "eslint-plugin-react-compiler";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  reactCompiler.configs.recommended,
  {
    // Register eslint-plugin-react-hooks manually in flat-config format.
    // The plugin's shipped `recommended-latest` config uses the legacy eslintrc
    // `plugins: ["react-hooks"]` array form, which ESLint 10 flat config rejects.
    // react-compiler's recommended config references react-hooks rules, so the
    // plugin must be registered here or those rules report "not found".
    plugins: { "react-hooks": reactHooks },
    rules: {
      // Verified zero violations as of 2026-08-05 audit. The earlier comment
      // claiming 15 pre-existing "hook called conditionally" violations was
      // stale — those were either fixed in a prior cleanup or never existed.
      // Raised to `error` in Phase 154 (2026-08-26) — 0 violations confirmed.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/.prisma/**", "**/src/generated/**", "**/__mocks__/**", "**/*.d.ts", "**/*.cjs"],
  },
  {
    files: ["packages/*/src/**/*.ts", "packages/*/src/**/*.tsx"],
    // No projectService: the config only enables syntax-only rules
    // (tseslint `recommended`, not `recommendedTypeChecked`), so no rule
    // consumes TypeScript type information. projectService was the source of
    // every lint parsing error after the tseslint 8.63 upgrade — it imposed an
    // 8-file allowDefaultProject cap and flagged test files as both
    // "in allowDefaultProject" and "found in the project service". Dropping it
    // lints source and tests uniformly with syntax rules and eliminates all
    // of those errors. (Re-enable projectService only if a `*TypeChecked`
    // ruleset is adopted, and then use a dedicated tsconfig that includes tests.)
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-namespace": "off",
      "no-useless-assignment": "off",
      "no-empty": ["error", { "allowEmptyCatch": true }],
      // This rule flags regexes containing control chars, but the codebase
      // intentionally strips control chars from user-supplied filenames and
      // binary content (packages/{server,collector}/src/utils/fileUtils.ts).
      // The pattern is deliberate sanitization, not a vulnerability.
      "no-control-regex": "off",
      // eslint-plugin-react-compiler is a release candidate (19.1.0-rc.2).
      // Before this upgrade it was effectively inert — it skipped every
      // component because react-hooks rules were not registered (a pre-existing
      // config gap). Now that react-hooks is registered, react-compiler performs
      // real analysis and surfaced 22 violations (19 frontend + 3 widget)
      // across the frontend and widget. All 22 were fixed in Phase 156
      // (2026-08-26) — 10 exhaustive-deps suppressions removed (which had been
      // causing react-compiler to skip whole components), the SsoSettingsPanel
      // conditional-hooks violation hoisted, the RestoreConfirmDialog
      // immutable-mutation site refactored, and the 3 widget ref-mirror
      // mutation sites suppressed per-line with documented intent. Test files
      // are exempt via the __tests__ override block below (react-compiler: off
      // for test render-components that capture refs for assertions — D-02).
      // Raised to `error` in Phase 156 (2026-08-26) — 0 violations confirmed.
      // The rule remains `error` going forward — new react-compiler violations
      // block CI. Bumping `eslint-plugin-react-compiler` from 19.1.0-rc.2 to a
      // future stable release is a separate dependency-upgrade task (D-03 — not
      // part of this phase).
      "react-compiler/react-compiler": "error",
      // Verified zero violations as of 2026-08-05 audit. The earlier comment
      // claiming pre-existing violations (7 throw-in-catch without cause,
      // 2 `Function` params, 1 async new Promise) was stale — those were
      // either fixed in a prior cleanup or never existed. Raised to `error`
      // in Phase 154 (2026-08-26) — 0 violations confirmed.
      "preserve-caught-error": "error",
      "@typescript-eslint/no-unsafe-function-type": "warn",
      "no-async-promise-executor": "warn",
    },
  },
  {
    // Test files use `@ts-nocheck` to bypass typing in mock-heavy tests
    // (e.g. packages/server/src/__tests__/ocrPipeline.test.ts). That is an
    // intentional local suppression; ban-ts-comment should not force removing it.
    files: ["packages/*/src/**/__tests__/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/ban-ts-comment": "off",
      // Test render-components that capture refs/variables for assertions
      // are not production render paths. react-compiler is a render-
      // optimization analyzer; its purity rules (no outer-scope variable
      // reassignment) should not constrain test-only capture patterns.
      // Mirrors the existing ban-ts-comment test-file override (D-02).
      "react-compiler/react-compiler": "off",
    },
  },
);
