import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';

import Decals, { type Decal } from '../../source/engine/client/renderer/effects/Decals.ts';
import R from '../../source/engine/client/R.ts';
import GL from '../../source/engine/client/GL.ts';
import type { GLTexture } from '../../source/engine/client/GL.ts';
import Vector from '../../source/shared/Vector.ts';
import { patchMembers, useClientStateOf } from '../support/clientState.ts';

const CLOCK = 100.0;
const texture = { name: 'bullet hole' } as unknown as GLTexture;

/**
 * Creates a decal that is not tied to a map.
 * @param die Time it runs out.
 * @returns The decal.
 */
function createDecal(die: number): Decal {
  const verts: [Vector, Vector, Vector, Vector] = [new Vector(0, 0, 0), new Vector(1, 0, 0), new Vector(1, 1, 0), new Vector(0, 1, 0)];

  return { texture, verts, color: new Vector(10, 20, 30), die, origin: new Vector() };
}

void describe('Decals', () => {
  let restoreClientState: () => void = () => {};
  let restoreRenderer: () => void = () => {};
  let lightResult: [Vector, Vector] | null = null;

  beforeEach(() => {
    Decals.Clear();
    lightResult = null;
    restoreClientState = useClientStateOf({ state: { time: CLOCK, worldmodel: { nodes: [{}] } } });
    restoreRenderer = patchMembers(R, { RecursiveLightPoint: () => lightResult });
  });

  afterEach(() => {
    restoreRenderer();
    restoreClientState();
    mock.restoreAll();
    Decals.Clear();
  });

  void describe('PlaceDecal', () => {
    void test('does nothing without a texture', () => {
      Decals.PlaceDecal(new Vector(), new Vector(0, 0, 1), null);

      assert.equal(Decals.list.length, 0);
    });

    void test('lays a 8x8 unit quad on the surface, nudged half a unit off it to avoid z-fighting', () => {
      Decals.PlaceDecal(new Vector(10, 20, 30), new Vector(0, 0, 1), texture);

      // for a floor the basis is right = +Y, up = +X: size 4 gives corners at +-4 around the origin
      assert.deepEqual(Decals.list[0].verts.map((vertex) => [...vertex]), [
        [14, 16, 30.5],
        [14, 24, 30.5],
        [6, 24, 30.5],
        [6, 16, 30.5],
      ]);
    });

    void test('is white when there is no light information at the spot', () => {
      Decals.PlaceDecal(new Vector(), new Vector(0, 0, 1), texture);

      assert.deepEqual([...Decals.list[0].color], [255, 255, 255]);
    });

    void test('takes the light at the spot, floored and clamped to a byte', () => {
      lightResult = [new Vector(300.7, 128.9, -5.0), new Vector()];

      Decals.PlaceDecal(new Vector(), new Vector(0, 0, 1), texture);

      assert.deepEqual([...Decals.list[0].color], [255, 128, 0]);
    });

    void test('lasts ten seconds', () => {
      Decals.PlaceDecal(new Vector(), new Vector(0, 0, 1), texture);

      assert.equal(Decals.list[0].die, CLOCK + 10.0);
    });

    void test('remembers the origin it was placed at', () => {
      const origin = new Vector(1, 2, 3);

      Decals.PlaceDecal(origin, new Vector(0, 0, 1), texture);
      origin.setTo(9, 9, 9);

      assert.deepEqual([...Decals.list[0].origin], [1, 2, 3]);
    });
  });

  void describe('PruneExpired', () => {
    void test('drops decals whose time has come, keeps the others', () => {
      Decals.list = [createDecal(CLOCK - 1.0), createDecal(CLOCK), createDecal(CLOCK + 1.0)];

      Decals.PruneExpired();

      assert.deepEqual(Decals.list.map((decal) => decal.die), [CLOCK + 1.0]);
    });
  });

  void describe('Clear', () => {
    void test('drops all decals', () => {
      Decals.list = [createDecal(CLOCK + 1.0)];

      Decals.Clear();

      assert.equal(Decals.list.length, 0);
    });
  });

  void describe('EmitQuad', () => {
    void test('streams two triangles with the decal color, sharing the 0-2 diagonal', () => {
      const vertices: string[] = [];
      let spaceRequested = 0;
      let position: number[] = [];
      let uv: number[] = [];

      mock.method(GL, 'StreamGetSpace', (count: number) => { spaceRequested = count; });
      mock.method(GL, 'StreamWriteFloat3', (x: number, y: number, z: number) => { position = [x, y, z]; });
      mock.method(GL, 'StreamWriteFloat2', (u: number, v: number) => { uv = [u, v]; });
      mock.method(GL, 'StreamWriteUByte4', (r: number, g: number, b: number, a: number) => {
        vertices.push(`${position.join(',')} uv ${uv.join(',')} rgba ${[r, g, b, a].join(',')}`);
      });

      Decals.EmitQuad(createDecal(CLOCK + 1.0));

      assert.equal(spaceRequested, 6);
      assert.deepEqual(vertices, [
        '0,0,0 uv 0,0 rgba 10,20,30,255',
        '1,0,0 uv 1,0 rgba 10,20,30,255',
        '1,1,0 uv 1,1 rgba 10,20,30,255',
        '0,0,0 uv 0,0 rgba 10,20,30,255',
        '1,1,0 uv 1,1 rgba 10,20,30,255',
        '0,1,0 uv 0,1 rgba 10,20,30,255',
      ]);
    });
  });
});
