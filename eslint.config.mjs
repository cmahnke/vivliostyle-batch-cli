import globals from "globals";
import tseslint from "typescript-eslint";

export default [
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.browser },
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { vars: "all", args: "after-used", ignoreRestSiblings: false }],
      "no-unused-vars": [
        "warn",
        { vars: "all", args: "after-used", ignoreRestSiblings: false, argsIgnorePattern: "^_", varsIgnorePattern: "^_" }
      ],
      "no-warning-comments": ["warn", {}],
      "no-irregular-whitespace": ["warn", {}]
    }
  },
  {
    ignores: ["dist/", "eslint.config.mjs"]
  }
];
