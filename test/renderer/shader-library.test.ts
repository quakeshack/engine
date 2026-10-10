import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { MissingResourceError } from '../../source/engine/common/Errors.ts';
import { ShaderLibrary } from '../../source/engine/client/renderer/programs/ShaderLibrary.ts';

const SHADER_DIRECTORY = new URL('../../source/engine/client/shaders/', import.meta.url);

/**
 * Reads all files with one of the extensions from a directory, by file name.
 * @param directory Directory to read.
 * @param extensions Extensions to keep, with the dot.
 * @returns File contents by file name.
 */
function readSources(directory: URL, extensions: string[]): Record<string, string> {
  const sources: Record<string, string> = {};

  // The chunk directory appears with the first chunk.
  if (!existsSync(directory)) {
    return sources;
  }

  for (const name of readdirSync(directory)) {
    if (extensions.some((extension) => name.endsWith(extension))) {
      sources[name] = readFileSync(new URL(name, directory), 'utf8');
    }
  }

  return sources;
}

const realLibrary = new ShaderLibrary(
  readSources(SHADER_DIRECTORY, ['.vert', '.frag']),
  readSources(new URL('include/', SHADER_DIRECTORY), ['.glsl']),
);

const glslang = spawnSync('glslangValidator', ['--version']);
const glslangMissing = glslang.error !== undefined;

void describe('ShaderLibrary', () => {
  void describe('build', () => {
    void test('expands both stages of a program', () => {
      const library = new ShaderLibrary(
        { 'p.vert': '#version 300 es\n#include "c.glsl"', 'p.frag': '#version 300 es\nvoid main() {}' },
        { 'c.glsl': 'float c;' },
      );
      const program = library.build('p');

      assert.ok(program.vertex.source.includes('float c;'));
      assert.deepEqual(program.vertex.files, ['p.vert', 'c.glsl']);
      assert.deepEqual(program.fragment.files, ['p.frag']);
    });

    void test('returns the same object for the same program', () => {
      const library = new ShaderLibrary({ 'p.vert': 'a', 'p.frag': 'b' }, {});

      assert.equal(library.build('p'), library.build('p'));
    });

    void test('names the missing stage and the restart hint', () => {
      const library = new ShaderLibrary({ 'p.vert': 'a' }, {});

      assert.throws(() => library.build('p'), (error: Error) => {
        assert.ok(error instanceof MissingResourceError);
        assert.match(error.message, /shaders\/p\.frag\./);
        assert.doesNotMatch(error.message, /p\.vert/);
        assert.match(error.message, /restart the active Vite build/);
        return true;
      });
    });
  });

  void describe('error mapping', () => {
    void test('points a driver error in a chunk at the line in the chunk file (glslang)', { skip: glslangMissing ? 'glslangValidator is not on PATH' : false }, () => {
      const library = new ShaderLibrary(
        { 'p.vert': 'x', 'p.frag': '#version 300 es\nprecision highp float;\nout vec4 color;\n#include "broken.glsl"\nvoid main() { color = vec4(1.0); }\nundeclaredAfter;\n' },
        { 'broken.glsl': '// line 1\nfloat fine = 1.0;\nundeclaredInChunk;\n' },
      );
      const stage = library.build('p').fragment;
      const directory = mkdtempSync(join(tmpdir(), 'shader-library-'));

      try {
        const path = join(directory, 'p.frag');

        writeFileSync(path, stage.source);

        const inChunk = spawnSync('glslangValidator', ['-S', 'frag', path], { encoding: 'utf8' }).stdout;

        assert.match(stage.mapInfoLog(inChunk), /^ERROR: broken\.glsl:3:/m);

        writeFileSync(path, stage.source.replace('undeclaredInChunk;', ''));

        const afterChunk = spawnSync('glslangValidator', ['-S', 'frag', path], { encoding: 'utf8' }).stdout;

        assert.match(stage.mapInfoLog(afterChunk), /^ERROR: p\.frag:6:/m);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });

  void describe('programIdentifiers', () => {
    void test('lists programs that have both stages', () => {
      const library = new ShaderLibrary({ 'b.vert': '', 'b.frag': '', 'a.vert': '', 'a.frag': '', 'lonely.vert': '' }, {});

      assert.deepEqual(library.programIdentifiers, ['a', 'b']);
    });
  });

  void describe('the shaders of the engine', () => {
    void test('finds the programs', () => {
      assert.ok(realLibrary.programIdentifiers.length >= 30, `found ${realLibrary.programIdentifiers.join(', ')}`);
    });

    void test('every stage has a vertex counterpart, the other way around too', () => {
      const names = Object.keys(readSources(SHADER_DIRECTORY, ['.vert', '.frag']));
      const stems = (extension: string): string[] => names.filter((name) => name.endsWith(extension)).map((name) => name.slice(0, -extension.length)).sort();

      assert.deepEqual(stems('.vert'), stems('.frag'));
    });

    void test('every program expands, nothing of #include survives and #version is the first line', () => {
      for (const identifier of realLibrary.programIdentifiers) {
        const { vertex, fragment } = realLibrary.build(identifier);

        for (const stage of [vertex, fragment]) {
          assert.doesNotMatch(stage.source, /^\s*#\s*include\b/m, `${identifier}: ${stage.files[0]}`);
          assert.ok(stage.source.startsWith('#version 300 es'), stage.files[0]);
        }
      }
    });

    void test('no function is defined in more than one shader file, a shared routine belongs in a chunk', () => {
      const sources = {
        ...readSources(SHADER_DIRECTORY, ['.vert', '.frag']),
        ...readSources(new URL('include/', SHADER_DIRECTORY), ['.glsl']),
      };
      const definitions = new Map<string, string[]>();

      for (const [file, source] of Object.entries(sources)) {
        for (const [, name] of source.matchAll(/^(?:float|int|bool|void|[ib]?vec[234]|mat[234])\s+(\w+)\s*\([^)]*\)\s*\{/gm)) {
          if (name !== 'main') {
            definitions.set(name, [...(definitions.get(name) ?? []), file]);
          }
        }
      }

      // Functions that are deliberately different per program would be listed here, with the reason.
      const duplicated = [...definitions].filter(([, files]) => files.length > 1).map(([name, files]) => `${name}: ${files.join(', ')}`);

      assert.deepEqual(duplicated, []);
    });

    void test('every chunk is included by some program', () => {
      const used = new Set<string>();

      for (const identifier of realLibrary.programIdentifiers) {
        const { vertex, fragment } = realLibrary.build(identifier);

        for (const file of [...vertex.files, ...fragment.files]) {
          used.add(file);
        }
      }

      assert.deepEqual(realLibrary.chunkNames.filter((name) => !used.has(name)), []);
    });

    void test('every expanded program compiles and links, so vertex outputs match fragment inputs (glslang)', { skip: glslangMissing ? 'glslangValidator is not on PATH' : false }, () => {
      const directory = mkdtempSync(join(tmpdir(), 'shader-library-'));
      const failures: string[] = [];

      try {
        for (const identifier of realLibrary.programIdentifiers) {
          const { vertex, fragment } = realLibrary.build(identifier);
          const vertexPath = join(directory, `${identifier}.vert`);
          const fragmentPath = join(directory, `${identifier}.frag`);

          writeFileSync(vertexPath, vertex.source);
          writeFileSync(fragmentPath, fragment.source);

          // -l links the stages into one program, which is where a varying that only one side declares shows up.
          const result = spawnSync('glslangValidator', ['-l', vertexPath, fragmentPath], { encoding: 'utf8' });

          if (result.status !== 0) {
            failures.push(`${identifier}:\n${result.stdout.replaceAll(directory, '')}`);
          }
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }

      assert.deepEqual(failures, []);
    });

    void test('the fog blend exists only in its chunk', () => {
      const withBlend = Object.entries(readSources(SHADER_DIRECTORY, ['.vert', '.frag'])).filter(([, source]) => source.includes('isNoFog')).map(([name]) => name);

      assert.deepEqual(withBlend, []);
      assert.ok(readSources(new URL('include/', SHADER_DIRECTORY), ['.glsl'])['fog-vertex.glsl'].includes('isNoFog'));
    });
  });
});
