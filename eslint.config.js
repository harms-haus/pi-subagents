import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import importPlugin from "eslint-plugin-import-x";
import unicorn from "eslint-plugin-unicorn";
import { fixupPluginRules } from "@eslint/compat";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "**/*.js", "**/*.cjs", "**/*.mjs"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      import: fixupPluginRules(importPlugin),
      unicorn,
    },
    rules: {
      // Core strict rules
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      eqeqeq: ["error", "always"],
      "prefer-template": "error",
      "prefer-const": "error",
      "no-var": "error",
      curly: ["error", "all"],
      "no-param-reassign": "off",
      "no-console": "off",
      // Import ordering
      "import/order": ["error", { groups: ["builtin", "external", "internal", "parent", "sibling", "index", "type"], "newlines-between": "never", alphabetize: { order: "asc", caseInsensitive: true } }],
      "import/no-duplicates": "error",
      "import/no-cycle": "off",
      "import/no-unresolved": "off",
      // Unicorn
      "unicorn/prefer-top-level-await": "off",
      "unicorn/no-null": "off",
      "unicorn/prevent-abbreviations": "off",
      "unicorn/filename-case": ["error", { case: "kebabCase" }],
      "unicorn/prefer-spread": "warn",
      "unicorn/prefer-ternary": "warn",
      "unicorn/consistent-function-scoping": "warn",
      "unicorn/prefer-event-target": "off",
    },
    settings: {
      "import/resolver": { typescript: true, node: true },
    },
  },
  // Relax rules for test files
  {
    files: ["src/__tests__/**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "import/order": "off",
      "unicorn/consistent-function-scoping": "off",
    },
  },
);
