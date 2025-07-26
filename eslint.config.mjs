import globals from 'globals';
import pluginJs from '@eslint/js';
import jsdoc from 'eslint-plugin-jsdoc';
import stylistic from '@stylistic/eslint-plugin';

/** @type {import('eslint').Linter.Config[]} */
export default [
  { files: ['**/*.js'], languageOptions: { sourceType: 'commonjs' } },
  {
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@stylistic': stylistic,
    },
    rules: {
      'max-len': 'off',
      'new-cap': 'off',
      'no-mixed-spaces-and-tabs': 'warn',
      'array-callback-return': 'error',
      'no-constructor-return': 'error',
      'no-duplicate-imports': 'error',
      'no-inner-declarations': 'error',
      'no-self-compare': 'error',
      'no-template-curly-in-string': 'warn',
      'no-unmodified-loop-condition': 'error',
      'no-unreachable-loop': 'warn',
      'curly': 'error',
      'consistent-return': 'error',
      'consistent-this': ['error', 'that'],
      'func-name-matching': 'error',
      'yoda': 'error',
      'arrow-body-style': ['error', 'as-needed'],
      'prefer-numeric-literals': 'error',
      // 'no-useless-assignment': 'error', -- too janky
      'require-atomic-updates': 'warn',
      'camelcase': 'off',
      'no-use-before-define': 'off',
      'require-yield': 'error',
      'no-debugger': 'warn',
      'semi': ['error', 'always'],
      'comma-dangle': ['error', 'always-multiline'],
      'eol-last': ['error', 'always'],
      'quotes': ['error', 'single', { avoidEscape: true }],
      // 'no-magic-numbers': ['warn', { 'ignore': [0,1,2], 'ignoreArrayIndexes': true }],
      // "no-plusplus": ["error", { "allowForLoopAfterthoughts": true }],
      'eqeqeq': ['warn', 'always'],
      'no-undef': 'error',
      'no-unused-vars': 'error',
      'jsdoc/check-types': 'error', // Ensures types are valid
      'jsdoc/require-param-description': 'off',
      'no-global-assign': 'warn',
      "no-param-reassign": ["warn", { "props": true }],
    },
  },
  pluginJs.configs.recommended,
  jsdoc.configs['flat/recommended'],
];
