import js from "@eslint/js";
import tseslint from "typescript-eslint";
import jsxA11y from "eslint-plugin-jsx-a11y";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/generated/**", "**/.next/**", "**/coverage/**", "**/next-env.d.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-console": "error"
    }
  },
  {
    // Accessibility: every <img> needs alt text, controls need labels, etc. Fails CI instead of relying on memory.
    files: ["apps/web/**/*.tsx"],
    plugins: { "jsx-a11y": jsxA11y },
    rules: { ...jsxA11y.flatConfigs.recommended.rules }
  },
  { files: ["scripts/**", "**/*.mjs"], languageOptions: { globals: { process: "readonly", console: "readonly", fetch: "readonly", setTimeout: "readonly" } }, rules: { "no-console": "off" } }
);
