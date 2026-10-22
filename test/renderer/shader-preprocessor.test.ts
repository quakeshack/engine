import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ShaderPreprocessor } from '../../source/engine/client/renderer/programs/ShaderPreprocessor.ts';

const STAGE = [
  '#version 300 es',
  'precision highp float;',
  '',
  '#include "a.glsl"',
  'void main() {}',
  '',
].join('\n');

void describe('ShaderPreprocessor', () => {
  void describe('expand', () => {
    void test('returns a stage without includes unchanged', () => {
      const preprocessor = new ShaderPreprocessor({});
      const source = '#version 300 es\nvoid main() {}\n';
      const expanded = preprocessor.expand('plain.frag', source);

      assert.equal(expanded.source, source);
      assert.deepEqual(expanded.files, ['plain.frag']);
    });

    void test('replaces the include with the chunk, wrapped in #line directives', () => {
      const preprocessor = new ShaderPreprocessor({ 'a.glsl': 'float a = 1.0;\nfloat b = 2.0;\n' });
      const expanded = preprocessor.expand('x.frag', STAGE);

      assert.equal(expanded.source, [
        '#version 300 es',
        'precision highp float;',
        '',
        '#line 1 1',
        'float a = 1.0;',
        'float b = 2.0;',
        '#line 5 0',
        'void main() {}',
      ].join('\n'));
      assert.deepEqual(expanded.files, ['x.frag', 'a.glsl']);
    });

    void test('keeps #version as the first line', () => {
      const preprocessor = new ShaderPreprocessor({ 'a.glsl': 'float a = 1.0;' });

      assert.ok(preprocessor.expand('x.frag', STAGE).source.startsWith('#version 300 es\n'));
    });

    void test('accepts a chunk without a final newline and CRLF line endings', () => {
      const preprocessor = new ShaderPreprocessor({ 'a.glsl': 'float a = 1.0;\r\nfloat b = 2.0;' });
      const expanded = preprocessor.expand('x.frag', STAGE.replaceAll('\n', '\r\n'));

      assert.equal(expanded.source.includes('\r'), false);
      assert.ok(expanded.source.includes('float b = 2.0;\n#line 5 0\n'));
    });

    void test('expands a chunk once per stage and keeps the line count of the stage', () => {
      const preprocessor = new ShaderPreprocessor({ 'a.glsl': 'float a = 1.0;' });
      const expanded = preprocessor.expand('x.frag', '#version 300 es\n#include "a.glsl"\n#include "a.glsl"\nvoid main() {}');

      assert.equal(expanded.source, '#version 300 es\n#line 1 1\nfloat a = 1.0;\n#line 3 0\n\nvoid main() {}');
      assert.equal(expanded.source.split('\n').filter((line) => line === 'float a = 1.0;').length, 1);
      assert.deepEqual(expanded.files, ['x.frag', 'a.glsl']);
    });

    void test('expands each stage on its own', () => {
      const preprocessor = new ShaderPreprocessor({ 'a.glsl': 'float a = 1.0;' });

      assert.ok(preprocessor.expand('x.vert', STAGE).source.includes('float a = 1.0;'));
      assert.ok(preprocessor.expand('x.frag', STAGE).source.includes('float a = 1.0;'));
    });
  });

  void describe('nested includes', () => {
    const chunks = {
      'outer.glsl': 'float outer1 = 1.0;\n#include "inner.glsl"\nfloat outer3 = 3.0;\n',
      'inner.glsl': 'float inner = 2.0;\n',
    };

    void test('returns to the including file at the line after the include', () => {
      const expanded = new ShaderPreprocessor(chunks).expand('x.frag', '#version 300 es\n#include "outer.glsl"\nvoid main() {}');

      assert.equal(expanded.source, [
        '#version 300 es',
        '#line 1 1',
        'float outer1 = 1.0;',
        '#line 1 2',
        'float inner = 2.0;',
        '#line 3 1',
        'float outer3 = 3.0;',
        '#line 3 0',
        'void main() {}',
      ].join('\n'));
      assert.deepEqual(expanded.files, ['x.frag', 'outer.glsl', 'inner.glsl']);
    });

    void test('drops a diamond: the shared chunk is included by the first path only', () => {
      const preprocessor = new ShaderPreprocessor({
        'left.glsl': '#include "base.glsl"\nfloat left = 1.0;',
        'right.glsl': '#include "base.glsl"\nfloat right = 1.0;',
        'base.glsl': 'float base = 1.0;',
      });
      const expanded = preprocessor.expand('x.frag', '#version 300 es\n#include "left.glsl"\n#include "right.glsl"');

      assert.equal(expanded.source.split('\n').filter((line) => line === 'float base = 1.0;').length, 1);
    });
  });

  void describe('errors', () => {
    void test('throws for an include cycle and names the path', () => {
      const preprocessor = new ShaderPreprocessor({
        'a.glsl': '#include "b.glsl"',
        'b.glsl': '#include "a.glsl"',
      });

      assert.throws(() => preprocessor.expand('x.frag', '#version 300 es\n#include "a.glsl"'), /x\.frag: b\.glsl:1: include cycle a\.glsl -> b\.glsl -> a\.glsl/);
    });

    void test('throws for a chunk that includes itself', () => {
      const preprocessor = new ShaderPreprocessor({ 'a.glsl': 'float a;\n#include "a.glsl"' });

      assert.throws(() => preprocessor.expand('x.frag', '#include "a.glsl"'), /a\.glsl:2: include cycle/);
    });

    void test('throws for an unknown chunk with stage, file and line', () => {
      const preprocessor = new ShaderPreprocessor({});

      assert.throws(() => preprocessor.expand('x.frag', '#version 300 es\n\n#include "missing.glsl"'), /x\.frag: x\.frag:3: unknown chunk "missing\.glsl"/);
    });

    void test('does not find chunks among inherited object properties', () => {
      const preprocessor = new ShaderPreprocessor({});

      assert.throws(() => preprocessor.expand('x.frag', '#include "constructor.glsl"'), /unknown chunk/);
    });

    for (const line of ['#include <a.glsl>', '#include "a.glsl" // note', '#include a.glsl', '#include "a.glsl" "b.glsl"', '#include ""']) {
      void test(`throws for the malformed line ${line}`, () => {
        const preprocessor = new ShaderPreprocessor({ 'a.glsl': 'float a;', 'b.glsl': 'float b;' });

        assert.throws(() => preprocessor.expand('x.frag', line), /malformed include/);
      });
    }

    for (const name of ['../a.glsl', 'sub/a.glsl', '/a.glsl', 'https://example.com/a.glsl', 'a.txt', '.hidden.glsl']) {
      void test(`rejects the chunk name ${name}`, () => {
        const preprocessor = new ShaderPreprocessor({ [name]: 'float a;' });

        assert.throws(() => preprocessor.expand('x.frag', `#include "${name}"`), /malformed include/);
      });
    }

    void test('throws when a chunk declares #version', () => {
      const preprocessor = new ShaderPreprocessor({ 'a.glsl': '#version 300 es\nfloat a;' });

      assert.throws(() => preprocessor.expand('x.frag', '#include "a.glsl"'), /a\.glsl:1: a chunk must not declare #version/);
    });

    void test('leaves a commented-out include alone', () => {
      const preprocessor = new ShaderPreprocessor({});
      const source = '#version 300 es\n// #include "a.glsl"\n';

      assert.equal(preprocessor.expand('x.frag', source).source, source);
    });
  });

  void describe('mapInfoLog', () => {
    void test('names the file behind the source string number', () => {
      const expanded = new ShaderPreprocessor({ 'a.glsl': 'float a;' }).expand('x.frag', '#include "a.glsl"');
      const log = "ERROR: 1:41: 'x' : undeclared identifier\nWARNING: 0:7: 'y' : unused\n";

      assert.equal(expanded.mapInfoLog(log), "ERROR: a.glsl:41: 'x' : undeclared identifier\nWARNING: x.frag:7: 'y' : unused\n");
    });

    void test('leaves unknown source string numbers and other text alone', () => {
      const expanded = new ShaderPreprocessor({}).expand('x.frag', 'void main() {}');
      const log = "ERROR: 9:1: 'x' : bad\nERROR: 0:1 not in the usual form\nsomething else\n";

      assert.equal(expanded.mapInfoLog(log), log);
    });
  });

  void describe('chunkNames', () => {
    void test('lists the chunks sorted', () => {
      assert.deepEqual(new ShaderPreprocessor({ 'b.glsl': '', 'a.glsl': '' }).chunkNames, ['a.glsl', 'b.glsl']);
    });
  });
});
