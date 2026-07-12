import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { BrushModel } from '../../source/engine/common/model/BSP.ts';
import { Face } from '../../source/engine/common/model/BaseModel.ts';
import { BSPXLoader } from '../../source/engine/common/model/BSPXLoader.ts';
import { eventBus, registry } from '../../source/engine/registry.ts';

const silentCon = /** @type {typeof import('../../source/engine/common/Console.ts').default} */ ({
  Print() {},
  DPrint() {},
  PrintWarning() {},
  PrintError() {},
  PrintSuccess() {},
});

/**
 * Temporarily install a silent `Con` and publish `registry.frozen` so
 * `BSPXLoader`'s module-level binding picks it up, then restore afterward.
 * @param {() => void} callback test body to run under the mock
 */
function withSilentCon(callback) {
  const previousCon = registry.Con;

  Object.assign(registry, { Con: silentCon });
  eventBus.publish('registry.frozen');

  try {
    callback();
  } finally {
    Object.assign(registry, { Con: previousCon });
    eventBus.publish('registry.frozen');
  }
}

const BSPX_MAGIC = 0x58505342;

/**
 * Build a BSPX trailer (magic + lump directory) containing a single named lump, followed by
 * the lump's raw payload bytes.
 * @param {number} bspxoffset offset the trailer starts at (rounded up to 4 bytes internally)
 * @param {string} lumpName BSPX lump name, e.g. 'FACENORMALS'
 * @param {Uint8Array} payload raw lump bytes
 * @returns {{buffer: ArrayBuffer, bspxoffset: number}} the full buffer and the offset to pass to BSPXLoader.load
 */
function buildBspxBuffer(bspxoffset, lumpName, payload) {
  const alignedOffset = (bspxoffset + 3) & ~3;
  const directoryOffset = alignedOffset + 8;
  const payloadOffset = directoryOffset + 32; // one lump entry
  const totalLength = payloadOffset + payload.length;

  const buffer = new ArrayBuffer(totalLength);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  view.setUint32(alignedOffset, BSPX_MAGIC, true);
  view.setUint32(alignedOffset + 4, 1, true); // numlumps

  const nameBytes = new TextEncoder().encode(lumpName);
  bytes.set(nameBytes.subarray(0, 24), directoryOffset);
  view.setUint32(directoryOffset + 24, payloadOffset, true); // fileofs
  view.setUint32(directoryOffset + 28, payload.length, true); // filelen

  bytes.set(payload, payloadOffset);

  return { buffer, bspxoffset };
}

/**
 * Encode a FACENORMALS BSPX lump payload: a table of unique vec3 vectors, followed by
 * per-face, per-vertex {normal, tangent, bitangent} index triplets.
 * @param {[number, number, number][]} vecs the shared vector table
 * @param {number[][][]} perFaceIndices one `[normalIndex, tangentIndex, bitangentIndex][]` array per face
 * @returns {Uint8Array} the encoded lump payload
 */
function encodeFaceNormals(vecs, perFaceIndices) {
  const vertexCount = perFaceIndices.reduce((sum, face) => sum + face.length, 0);
  const totalLength = 4 + vecs.length * 12 + vertexCount * 12;
  const buffer = new ArrayBuffer(totalLength);
  const view = new DataView(buffer);
  let offset = 0;

  view.setUint32(offset, vecs.length, true);
  offset += 4;

  for (const [x, y, z] of vecs) {
    view.setFloat32(offset, x, true);
    view.setFloat32(offset + 4, y, true);
    view.setFloat32(offset + 8, z, true);
    offset += 12;
  }

  for (const face of perFaceIndices) {
    for (const [normalIndex, tangentIndex, bitangentIndex] of face) {
      view.setUint32(offset, normalIndex, true);
      view.setUint32(offset + 4, tangentIndex, true);
      view.setUint32(offset + 8, bitangentIndex, true);
      offset += 12;
    }
  }

  return new Uint8Array(buffer);
}

/**
 * @param {number} numedges
 * @returns {Face} a bare Face with the given edge count, as would exist after `_loadFaces`
 */
function createFace(numedges) {
  const face = new Face();
  face.numedges = numedges;
  return face;
}

void describe('BSPXLoader FACENORMALS lump', () => {
  void test('assigns per-vertex normals/tangents/bitangents aligned to each face\'s edge order', () => {
    const loadmodel = new BrushModel('test');
    loadmodel.faces = [createFace(3), createFace(4)];

    const vecs = [
      [0.0, 0.0, 1.0],
      [1.0, 0.0, 0.0],
      [0.0, 1.0, 0.0],
      [0.0, 0.0, -1.0],
    ];
    const payload = encodeFaceNormals(vecs, [
      [[0, 1, 2], [0, 1, 2], [0, 1, 2]],
      [[3, 1, 2], [3, 1, 2], [3, 1, 2], [3, 1, 2]],
    ]);
    const { buffer, bspxoffset } = buildBspxBuffer(0, 'FACENORMALS', payload);

    withSilentCon(() => {
      BSPXLoader.load(loadmodel, buffer, bspxoffset);
    });

    assert.ok(loadmodel.bspxlumps !== null);
    assert.ok('FACENORMALS' in loadmodel.bspxlumps);

    const [triangleFace, quadFace] = loadmodel.faces;

    assert.equal(triangleFace.vertexNormals?.length, 3);
    assert.deepEqual([...triangleFace.vertexNormals[0]], vecs[0]);
    assert.deepEqual([...triangleFace.vertexTangents[0]], vecs[1]);
    assert.deepEqual([...triangleFace.vertexBitangents[0]], vecs[2]);

    assert.equal(quadFace.vertexNormals?.length, 4);
    assert.deepEqual([...quadFace.vertexNormals[3]], vecs[3]);
  });

  void test('leaves vertexNormals null when no FACENORMALS lump is present', () => {
    const loadmodel = new BrushModel('test');
    loadmodel.faces = [createFace(3)];

    const { buffer, bspxoffset } = buildBspxBuffer(0, 'LIGHTINGDIR', new Uint8Array(3));

    withSilentCon(() => {
      BSPXLoader.load(loadmodel, buffer, bspxoffset);
    });

    assert.equal(loadmodel.faces[0].vertexNormals, null);
  });

  void test('leaves vertexNormals null and does not throw on a truncated lump', () => {
    const loadmodel = new BrushModel('test');
    loadmodel.faces = [createFace(3)];

    const vecs = [[0.0, 0.0, 1.0]];
    const fullPayload = encodeFaceNormals(vecs, [[[0, 0, 0], [0, 0, 0], [0, 0, 0]]]);
    const truncatedPayload = fullPayload.subarray(0, fullPayload.length - 4);
    const { buffer, bspxoffset } = buildBspxBuffer(0, 'FACENORMALS', truncatedPayload);

    withSilentCon(() => {
      assert.doesNotThrow(() => BSPXLoader.load(loadmodel, buffer, bspxoffset));
    });

    assert.equal(loadmodel.faces[0].vertexNormals, null);
  });

  void test('leaves vertexNormals null when a vector index is out of range', () => {
    const loadmodel = new BrushModel('test');
    loadmodel.faces = [createFace(1)];

    const vecs = [[0.0, 0.0, 1.0]];
    const payload = encodeFaceNormals(vecs, [[[0, 0, 5]]]); // index 5 is out of range
    const { buffer, bspxoffset } = buildBspxBuffer(0, 'FACENORMALS', payload);

    withSilentCon(() => {
      BSPXLoader.load(loadmodel, buffer, bspxoffset);
    });

    assert.equal(loadmodel.faces[0].vertexNormals, null);
  });
});
