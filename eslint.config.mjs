import globals from "globals";
import pluginJs from "@eslint/js";


/** @type {import('eslint').Linter.Config[]} */
export default [
  {files: ["**/*.js"], languageOptions: {sourceType: "commonjs"}},
  {languageOptions: {
    globals: globals.browser,
    parserOptions: {
        // 'latest' is recognized by ESLint 9. You can also use a numeric version like 2022 or 2023.
        ecmaVersion: 'latest',
        sourceType: 'module', // If you are using ES Modules (import/export).
      },
    },
    rules: {
      'max-len': 'off',
      'new-cap': 'off',
      'no-mixed-spaces-and-tabs': 'off',
      'no-tabs': 'off',
      'camelcase': 'off',
      // 'no-globoal-assign': 'warn',
    },
  },
  pluginJs.configs.recommended,
];
