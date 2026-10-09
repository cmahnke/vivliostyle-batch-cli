import globals from "globals";
import tseslint from "typescript-eslint";

export default [
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.browser },
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { vars: "all", args: "after-used", ignoreRestSiblings: false }],
      // The base rule reports parameter names of TypeScript function type
      // annotations and interface members as unused; the TS-aware rule above
      // handles those correctly.
      "no-unused-vars": "off",
      "no-warning-comments": ["warn", {}],
      "no-irregular-whitespace": ["warn", {}]
    }
  },
  {
    ignores: ["dist/", "eslint.config.mjs", "docs/", "pdf/"]
  }
];
