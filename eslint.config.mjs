import globals from 'globals';
import pluginJs from '@eslint/js';
import jsdoc from 'eslint-plugin-jsdoc';
import sortClassMembers from 'eslint-plugin-sort-class-members';

/** @type {import('eslint').Linter.Config[]} */
export default [
  { files: ['**/*.js'], languageOptions: { sourceType: 'commonjs' } },
  {
    languageOptions: {
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
      'no-mixed-spaces-and-tabs': 'warn',
      'no-tabs': 'warn',
      'camelcase': 'off',
      'no-use-before-define': 'off',
      'require-yield': 'error',
      'no-debugger': 'warn',
      'semi': ['error', 'always'],
      'comma-dangle': ['error', 'always-multiline'],
      'eol-last': ['error', 'always'],
      'quotes': ['error', 'single', { 'avoidEscape': true }],
      // "no-magic-numbers": ["warn", { "ignore": [0,1], "ignoreArrayIndexes": true }],
      // "no-plusplus": ["error", { "allowForLoopAfterthoughts": true }],
      'eqeqeq': ['error', 'always'],
      'no-undef': 'error',
      'no-unused-vars': 'error',
      'jsdoc/check-types': 'error',       // Ensures types are valid
      'jsdoc/require-param-description': 'off',
      // 'no-globoal-assign': 'warn',
      // "sort-class-members/sort-class-members": ["error", {
      //   "order": [
      //     "[static-properties]",
      //     "[instance-properties]",
      //     "[static-methods]",
      //     "[instance-methods]"
      //   ],
      //   "groups": {
      //     "static-properties": [{ "type": "property", "static": true }],
      //     "instance-properties": [{ "type": "property", "static": false }],
      //     "static-methods": [{ "type": "method", "static": true }],
      //     "instance-methods": [{ "type": "method", "static": false }]
      //   },
      //   "accessorPairPositioning": "getThenSet"
      // }],
    },
  },
  pluginJs.configs.recommended,
  jsdoc.configs['flat/recommended'],
  // sortClassMembers.configs['flat/recommended'],
];
