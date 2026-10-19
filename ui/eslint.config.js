// ESLint for contrib settings tabs only (contrib/<name>/ui/*.tsx). The rest of the UI
// is not linted; widening this is adding globs to `files`.
//
// One rule: a contrib tab imports only @/components/*, @/lib/*, @/src/contrib/sdk and
// ui/package.json deps, so the app's internals can change without breaking contribs.
// The message names the fix, since whoever hits it is usually an agent writing a tab.
import tseslint from "typescript-eslint";

// Paths are relative to the repo root: lint:contrib runs from there with --config,
// because the tabs live outside ui/ and ESLint ignores files outside its base path.
export const CONTRIB_TABS = ["contrib/*/ui/*.tsx"];

// The fixture contrib/echo/ui/lint-fixture/ breaks the rule on purpose, and
// eslint.contrib.test.ts asserts ESLint rejects it, so a broken glob cannot make the
// rule pass everything silently.
export const LINT_FIXTURES = ["contrib/*/ui/lint-fixture/**"];

export const contribImportRule = {
  "no-restricted-imports": [
    "error",
    {
      patterns: [
        {
          // Any app source but the SDK, any climb out of the tab's own ui/, and any
          // absolute path. A regex, not a gitignore group: a group cannot re-include
          // @/src/contrib/sdk once @/src/* has excluded its directory.
          regex: "^(@/src/(?!contrib/sdk(\\.js)?$)|\\.\\./|/)",
          message:
            "Contrib tabs may import only @/components/*, @/lib/*, @/src/contrib/sdk " +
            "and ui/package.json deps. Need something else? Add it to the SDK " +
            "(ui/src/contrib/sdk.ts).",
        },
      ],
    },
  ],
};

export default tseslint.config(
  { ignores: LINT_FIXTURES },
  {
    files: [...CONTRIB_TABS, "contrib/*/ui/lint-fixture/*.tsx"],
    languageOptions: { parser: tseslint.parser },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: contribImportRule,
  },
);
