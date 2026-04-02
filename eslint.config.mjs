import { defineConfig } from 'eslint/config';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import globals from 'globals';
import pluginJs from '@eslint/js';
import jsdoc from 'eslint-plugin-jsdoc';
import stylistic from '@stylistic/eslint-plugin';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

const __dirname = dirname(fileURLToPath(import.meta.url));
const typeAwareParserOptions = {
  ecmaVersion: 'latest',
  sourceType: 'module',
  projectService: true,
  tsconfigRootDir: __dirname,
};

const jsdocPlugin = /** @type {import('eslint').ESLint.Plugin} */ (jsdoc);
const stylisticPlugin = /** @type {import('eslint').ESLint.Plugin} */ (stylistic);
const typeScriptEslintPlugin = /** @type {import('eslint').ESLint.Plugin} */ (
  /** @type {unknown} */ (tseslint)
);
const nodeGlobals = Object.fromEntries(
  Object.entries(globals.node).filter(([name]) => name !== 'Buffer'),
);

const commonRules = /** @type {import('eslint').Linter.RulesRecord} */ ({
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
  'jsdoc/check-types': 'error',
  'jsdoc/require-param-description': 'off',
  'no-global-assign': 'warn',
  // "no-param-reassign": ["warn", { "props": true }], -- too many false positives

  // TypeScript ESLint rules for JSDoc type checking
  '@typescript-eslint/no-unsafe-argument': 'off',
  '@typescript-eslint/no-unsafe-assignment': 'off',
  '@typescript-eslint/no-unsafe-call': 'off',
  '@typescript-eslint/no-unsafe-member-access': 'off',
  '@typescript-eslint/no-unsafe-return': 'off',
  '@typescript-eslint/strict-boolean-expressions': 'off',
  '@typescript-eslint/no-floating-promises': 'error',
  '@typescript-eslint/await-thenable': 'error',
  '@typescript-eslint/no-misused-promises': 'error',
  '@typescript-eslint/require-await': 'warn',
  '@typescript-eslint/no-redundant-type-constituents': 'warn',
});

export default defineConfig([
  {
    ignores: [
      '.env*',
      'dist/**',
      'public/libs/**',
      'data/**/*.mjs',
    ],
  },
  pluginJs.configs.recommended,
  jsdoc.configs['flat/recommended'],
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: globals.browser,
      parser: tsparser,
      parserOptions: typeAwareParserOptions,
    },
    plugins: {
      '@stylistic': stylisticPlugin,
      '@typescript-eslint': typeScriptEslintPlugin,
      jsdoc: jsdocPlugin,
    },
    rules: commonRules,
  },
  {
    files: ['**/*.{ts,mts,cts}'],
    languageOptions: {
      globals: globals.browser,
      parser: tsparser,
      parserOptions: typeAwareParserOptions,
    },
    plugins: {
      '@stylistic': stylisticPlugin,
      '@typescript-eslint': typeScriptEslintPlugin,
      jsdoc: jsdocPlugin,
    },
    rules: {
      ...commonRules,
      'jsdoc/require-param-type': 'off',
      'jsdoc/require-property-type': 'off',
      'jsdoc/require-returns-type': 'off',
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
    },
  },
  {
    files: [
      'dedicated.mjs',
      'dedicated.ts',
      'eslint.config.mjs',
      'eslint.config.ts',
      'vite.config.mjs',
      'vite.config.ts',
      'vite.config.dedicated.mjs',
      'vite.config.dedicated.ts',
      'source/engine/main-dedicated.mjs',
      'source/engine/main-dedicated.ts',
      'source/engine/server/**/*.{mjs,ts,mts,cts}',
      'source/engine/common/**/*.{mjs,ts,mts,cts}',
      'test/**/*.{mjs,ts,mts,cts}',
    ],
    languageOptions: {
      globals: nodeGlobals,
    },
  },
  {
    files: ['source/cloudflare/**/*.{mjs,ts,mts,cts}'],
    languageOptions: {
      globals: globals.serviceworker,
    },
  },
  {
    files: ['**/*.{cjs,cts}'],
    languageOptions: {
      sourceType: 'commonjs',
    },
  },
]);
