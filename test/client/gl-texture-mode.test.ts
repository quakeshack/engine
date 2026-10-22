import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import Cmd from '../../source/engine/common/Cmd.ts';
import Cvar from '../../source/engine/common/Cvar.ts';
import GL, { GLTexture } from '../../source/engine/client/GL.ts';
import VID from '../../source/engine/client/VID.ts';

/** One `texParameterf` the code under test made, and which texture it applied to. */
interface FilterCall {
  readonly texture: number;
  readonly parameter: number;
  readonly value: number;
}

const filterCalls: FilterCall[] = [];
const constants = new Map<string, number>();
let nextTextureId = 1;
let boundTexture = 0;

/**
 * Gives a WebGL constant (`gl.NEAREST`) a number of its own.
 * @param key The constant's name.
 * @returns The same number every time.
 */
function constant(key: string): number {
  if (!constants.has(key)) {
    constants.set(key, constants.size + 1);
  }

  return constants.get(key)!;
}

/** A WebGL context that accepts every call, and records what is applied to which texture. */
const fakeGl = new Proxy({} as Record<string, unknown>, {
  get(_target, key: string) {
    switch (key) {
      case 'getParameter':
        return () => 4096;
      case 'createTexture':
        return () => ({ id: nextTextureId++ });
      case 'bindTexture':
        return (_target2: number, texture: { id: number } | null) => { boundTexture = texture?.id ?? 0; };
      case 'texParameterf':
        return (_target2: number, parameter: number, value: number) => { filterCalls.push({ texture: boundTexture, parameter, value }); };
      case 'getError':
        return () => constant('NO_ERROR');
      default:
        break;
    }

    if (/^[A-Z][A-Z0-9_]*$/.test(key)) {
      return constant(key);
    }

    return () => ({});
  },
});

/**
 * Allocates a texture that is uploaded, so a change of mode reaches the context.
 * @param identifier The texture's name.
 * @returns The texture and the id its context object got.
 */
function allocate(identifier: string): { texture: GLTexture; id: number } {
  const texture = GLTexture.Allocate(identifier, 1, 1, new Uint8Array(4));
  const applied = filterCalls.filter((call) => call.parameter === constants.get('TEXTURE_MIN_FILTER'));

  return { texture, id: applied[applied.length - 1].texture };
}

/**
 * Tells which filters a texture got since the calls were last cleared.
 * @param id The texture's context id.
 * @returns The minification filters applied to it, in order.
 */
function minFiltersOf(id: number): number[] {
  return filterCalls.filter((call) => call.texture === id && call.parameter === constants.get('TEXTURE_MIN_FILTER')).map((call) => call.value);
}

before(() => {
  // GLTexture tells pixel data from an ImageBitmap by `instanceof`, which Node does not have
  (globalThis as { ImageBitmap?: unknown }).ImageBitmap ??= class ImageBitmap {};
  VID.mainwindow = { getContext: () => fakeGl } as unknown as HTMLCanvasElement;
  GL.Init();
});

after(() => {
  GL.Shutdown();
  Cvar.Shutdown();
});

void describe('gl_texturemode', () => {
  void test('changes the mode of every texture that follows it', async () => {
    const first = allocate('mode_first');
    const second = allocate('mode_second');
    filterCalls.length = 0;

    await Cmd.ExecuteString('gl_texturemode GL_NEAREST');

    assert.deepEqual(minFiltersOf(first.id), [constants.get('NEAREST')]);
    assert.deepEqual(minFiltersOf(second.id), [constants.get('NEAREST')]);

    first.texture.free();
    second.texture.free();
  });

  void test('leaves a texture alone that was locked to a mode', async () => {
    const free = allocate('mode_follows');
    const locked = allocate('mode_locked');
    locked.texture.lockTextureMode('GL_LINEAR');
    filterCalls.length = 0;

    await Cmd.ExecuteString('gl_texturemode GL_NEAREST_MIPMAP_NEAREST');

    assert.deepEqual(minFiltersOf(free.id), [constants.get('NEAREST_MIPMAP_NEAREST')]);
    assert.deepEqual(minFiltersOf(locked.id), []);

    free.texture.free();
    locked.texture.free();
  });

  void test('does not touch a texture that was freed', async () => {
    const freed = allocate('mode_freed');
    freed.texture.free();
    filterCalls.length = 0;

    await Cmd.ExecuteString('gl_texturemode GL_LINEAR');

    assert.deepEqual(minFiltersOf(freed.id), []);
  });

  void test('gives a texture allocated afterwards the mode that was chosen', async () => {
    await Cmd.ExecuteString('gl_texturemode GL_NEAREST');
    filterCalls.length = 0;

    const late = allocate('mode_late');

    assert.deepEqual(minFiltersOf(late.id), [constants.get('NEAREST')]);

    late.texture.free();
  });
});
