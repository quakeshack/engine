import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import Lightmaps from '../../source/engine/client/renderer/lighting/Lightmaps.ts';
import { LIGHTMAP_BLOCK_SIZE } from '../../source/engine/client/renderer/lighting/LightmapAtlas.ts';
import type { Face } from '../../source/engine/common/model/BaseModel.ts';

// Classic Quake lightmap shift: one lightmap texel covers 16 world units.
const LMSHIFT = 4;

interface Allocation {
  light_s: number;
  light_t: number;
}

/**
 * Creates a face that needs a block of the given size in the atlas.
 * @param width Block width in lightmap texels.
 * @param height Block height in lightmap texels.
 * @returns The face, with `light_s`/`light_t` still unset.
 */
function createFace(width: number, height: number): Face & Allocation {
  // AllocBlock derives the block size as (extents >> lmshift) + 1
  return {
    lmshift: LMSHIFT,
    extents: [(width - 1) << LMSHIFT, (height - 1) << LMSHIFT],
    light_s: -1,
    light_t: -1,
  } as unknown as Face & Allocation;
}

void describe('Lightmaps.AllocBlock', () => {
  const previousAllocated = Lightmaps.allocated;

  beforeEach(() => {
    Lightmaps.allocated = new Array<number>(LIGHTMAP_BLOCK_SIZE).fill(0);
  });

  afterEach(() => {
    Lightmaps.allocated = previousAllocated;
  });

  void test('places the first block in the top left corner', () => {
    const face = createFace(4, 3);

    Lightmaps.AllocBlock(face);

    assert.equal(face.light_s, 0);
    assert.equal(face.light_t, 0);
  });

  void test('raises the skyline of the columns it used by the block height', () => {
    Lightmaps.AllocBlock(createFace(4, 3));

    assert.deepEqual(Lightmaps.allocated.slice(0, 6), [3, 3, 3, 3, 0, 0]);
  });

  void test('puts the next block beside the first one while the columns next to it are lower', () => {
    const first = createFace(2, 3);
    const second = createFace(2, 5);

    Lightmaps.AllocBlock(first);
    Lightmaps.AllocBlock(second);

    assert.equal(second.light_s, 2);
    assert.equal(second.light_t, 0);
  });

  void test('stacks a block on the lowest skyline once every position is occupied', () => {
    const wide = createFace(LIGHTMAP_BLOCK_SIZE - 1, 10);
    const above = createFace(LIGHTMAP_BLOCK_SIZE - 1, 2);

    Lightmaps.AllocBlock(wide);
    Lightmaps.AllocBlock(above);

    assert.equal(above.light_s, 0);
    assert.equal(above.light_t, 10);
  });

  void test('throws when a block does not fit anymore', () => {
    Lightmaps.AllocBlock(createFace(LIGHTMAP_BLOCK_SIZE - 1, 1));

    assert.throws(() => { Lightmaps.AllocBlock(createFace(LIGHTMAP_BLOCK_SIZE - 1, LIGHTMAP_BLOCK_SIZE)); }, /full/);
  });
});
