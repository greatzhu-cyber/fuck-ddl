import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

const reactHooksRules =
  reactHooks.configs.flat?.recommended?.rules ??
  reactHooks.configs.recommended.rules;

export default [
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/target/**",
      "**/gen/schemas/**",
      "docs/design/**",
      "work/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.{js,mjs,jsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: globals.node,
    },
    rules: {
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["apps/web/src/**/*.{js,jsx}"],
    languageOptions: {
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: reactHooksRules,
  },
  {
    files: ["apps/web/public/**/*.{js,mjs}"],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: ["apps/edge-extension/**/*.{js,mjs}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        chrome: "readonly",
      },
    },
  },
];
