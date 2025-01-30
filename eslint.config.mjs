import globals from "globals";
import pluginJs from "@eslint/js";
import jsdoc from 'eslint-plugin-jsdoc';

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
      'jsdoc/check-types': 'error',       // Ensures types are valid
      'jsdoc/require-param-description': 'off'
      // 'no-globoal-assign': 'warn',
    },
  },
  pluginJs.configs.recommended,
  jsdoc.configs["flat/recommended"],
];
