import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { after, before, describe, mock, test } from 'node:test';

import GL from '../../source/engine/client/GL.ts';
import type { GLProgramInfo } from '../../source/engine/client/GL.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import ShaderPrograms from '../../source/engine/client/renderer/programs/ShaderPrograms.ts';
import { ShaderLibrary } from '../../source/engine/client/renderer/programs/ShaderLibrary.ts';
import { publishGlReady } from '../support/glEvents.ts';

const SHADER_DIRECTORY = new URL('../../source/engine/client/shaders/', import.meta.url);

/** One `GL.CreateProgram` call of `ShaderPrograms.Init`. */
interface ProgramEntry {
  readonly identifier: string;
  readonly uniforms: readonly string[];
  readonly textures: readonly string[];
}

/**
 * Reads all files with one of the extensions from a directory, by file name.
 * @param directory Directory to read.
 * @param extensions Extensions to keep, with the dot.
 * @returns File contents by file name.
 */
function readSources(directory: URL, extensions: string[]): Record<string, string> {
  const sources: Record<string, string> = {};

  for (const name of readdirSync(directory)) {
    if (extensions.some((extension) => name.endsWith(extension))) {
      sources[name] = readFileSync(new URL(name, directory), 'utf8');
    }
  }

  return sources;
}

/**
 * Collects the uniforms a GLSL source declares, an array by the name of its first element (`uDlightPos[0]`), the
 * way `GL.CreateProgram` is given them.
 * @param source Expanded shader source.
 * @returns The declared names.
 */
function declaredUniforms(source: string): string[] {
  const names: string[] = [];

  for (const match of source.matchAll(/^\s*uniform\s+(?:(?:lowp|mediump|highp)\s+)?\w+\s+(\w+)(\[\d+\])?\s*;/gm)) {
    names.push(match[2] !== undefined ? `${match[1]}[0]` : match[1]);
  }

  return names;
}

const library = new ShaderLibrary(
  readSources(SHADER_DIRECTORY, ['.vert', '.frag']),
  readSources(new URL('include/', SHADER_DIRECTORY), ['.glsl']),
);

void describe('ShaderPrograms.Init', () => {
  const entries: ProgramEntry[] = [];
  const previousContext = GL.gl;

  before(async () => {
    // Init reads only the attribute type constants of the context.
    GL.gl = { FLOAT: 0x1406, UNSIGNED_BYTE: 0x1401 } as unknown as WebGL2RenderingContext;
    publishGlReady(GL.gl);
    mock.method(GL, 'CreateProgram', (identifier: string, uniforms: string[], _attribs: unknown, textures: string[]) => {
      entries.push({ identifier, uniforms, textures });

      return {} as GLProgramInfo;
    });

    await ShaderPrograms.Init();
  });

  after(() => {
    mock.restoreAll();
    eventBus.publish('gl.shutdown');
    GL.gl = previousContext;
  });

  void test('creates programs', () => {
    assert.ok(entries.length > 0);
  });

  // A uniform that is not listed has no location on the program, so FrameUniforms and the renderers silently skip
  // it and the shader reads 0: r_shadow_point_bias never reached the point shadows that way.
  void test('lists every uniform and sampler a program declares, chunks included', () => {
    const unlisted: string[] = [];

    for (const { identifier, uniforms, textures } of entries) {
      const { vertex, fragment } = library.build(identifier);
      const listed = new Set([...uniforms, ...textures]);

      for (const name of new Set([...declaredUniforms(vertex.source), ...declaredUniforms(fragment.source)])) {
        if (!listed.has(name)) {
          unlisted.push(`${identifier}: ${name}`);
        }
      }
    }

    assert.deepEqual(unlisted, []);
  });
});
