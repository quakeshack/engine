import { describe, it } from 'node:test';

import { RuleTester } from 'eslint';

import plugin from '../../eslint.rules.mjs';

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
});

ruleTester.run('block-on-own-lines', plugin.rules['block-on-own-lines'], {
  valid: [
    'if (a) {\n  b();\n}',
    'if (a) {}',
    'if (a) {\n  b();\n} else {\n  c();\n}',
    // not control statements: a one-line function or getter is fine
    'const f = () => { g(); };',
    'class A { get x() { return 1; } }',
    'function f() { return 1; }',
    'const o = { a() { return 1; } };',
  ],

  invalid: [
    {
      code: 'function f() {\n  if (!a) { return; }\n}',
      output: 'function f() {\n  if (!a) {\n    return;\n  }\n}',
      errors: [{ messageId: 'ownLines' }],
    },
    {
      code: 'function f() {\n  if (a) { b(); c(); }\n}',
      output: 'function f() {\n  if (a) {\n    b();\n    c();\n  }\n}',
      errors: [{ messageId: 'ownLines' }],
    },
    {
      code: 'if (a) { b(); } else { c(); }',
      output: 'if (a) {\n  b();\n} else {\n  c();\n}',
      errors: [{ messageId: 'ownLines' }, { messageId: 'ownLines' }],
    },
    {
      code: 'for (const a of b) { c(a); }',
      output: 'for (const a of b) {\n  c(a);\n}',
      errors: [{ messageId: 'ownLines' }],
    },
    {
      code: 'while (x) { y(); }',
      output: 'while (x) {\n  y();\n}',
      errors: [{ messageId: 'ownLines' }],
    },
    {
      code: 'do { x(); } while (y);',
      output: 'do {\n  x();\n} while (y);',
      errors: [{ messageId: 'ownLines' }],
    },
    {
      code: 'try { a(); } catch (e) { b(e); } finally { c(); }',
      output: 'try {\n  a();\n} catch (e) {\n  b(e);\n} finally {\n  c();\n}',
      errors: [{ messageId: 'ownLines' }, { messageId: 'ownLines' }, { messageId: 'ownLines' }],
    },
    {
      // reported, and left alone: moving the comment is the author's call
      code: 'if (a) { /* why */ b(); }',
      output: null,
      errors: [{ messageId: 'ownLines' }],
    },
  ],
});
