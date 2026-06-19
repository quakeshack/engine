import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Mesh from '../../source/engine/client/renderer/Mesh.ts';

const STRIDE = 20;
const TANGENT_EPSILON = 1e-6;

/**
 * @param {number} px
 * @param {number} py
 * @param {number} pz
 * @param {number} u
 * @param {number} v
 * @returns {number[]} Vertex data in brush renderer stride layout.
 */
function createVertex(px, py, pz, u, v) {
  return [
    px, py, pz,
    u, v, 0.0, 0.0,
    0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 1.0,
    0.0, 0.0, 0.0,
    0.0, 0.0, 0.0,
  ];
}

/**
 * @param {number[]} cmds
 * @param {number} base
 * @returns {[number, number, number]} Tangent vector at the vertex base offset.
 */
function readTangent(cmds, base) {
  return [cmds[base + 14], cmds[base + 15], cmds[base + 16]];
}

/**
 * @param {number[]} cmds
 * @param {number} base
 * @returns {[number, number, number]} Bitangent vector at the vertex base offset.
 */
function readBitangent(cmds, base) {
  return [cmds[base + 17], cmds[base + 18], cmds[base + 19]];
}

/**
 * @param {[number, number, number]} lhs
 * @param {[number, number, number]} rhs
 */
function assertVecNear(lhs, rhs) {
  assert.ok(Math.abs(lhs[0] - rhs[0]) <= TANGENT_EPSILON);
  assert.ok(Math.abs(lhs[1] - rhs[1]) <= TANGENT_EPSILON);
  assert.ok(Math.abs(lhs[2] - rhs[2]) <= TANGENT_EPSILON);
}

/**
 * @param {[number, number, number]} value
 */
function assertUnitVector(value) {
  const length = Math.hypot(value[0], value[1], value[2]);
  assert.ok(Math.abs(length - 1.0) <= TANGENT_EPSILON);
}

void describe('Mesh.CalculateTangentBitangents', () => {
  void test('averages tangent space for duplicated shared vertices across triangles', () => {
    const commands = [
      ...createVertex(0.0, 0.0, 0.0, 0.0, 0.0),
      ...createVertex(1.0, 0.0, 0.0, 1.0, 0.0),
      ...createVertex(1.0, 1.0, 0.0, 1.0, 1.0),
      ...createVertex(0.0, 0.0, 0.0, 0.0, 0.0),
      ...createVertex(1.0, 1.0, 0.0, 1.0, 1.0),
      ...createVertex(0.0, 1.0, 0.0, 0.0, 2.0),
    ];

    Mesh.CalculateTangentBitangents(commands, commands.length);

    const firstSharedTangent = readTangent(commands, 0);
    const secondSharedTangent = readTangent(commands, STRIDE * 3);
    const firstDiagonalTangent = readTangent(commands, STRIDE * 2);
    const secondDiagonalTangent = readTangent(commands, STRIDE * 4);

    assertVecNear(firstSharedTangent, secondSharedTangent);
    assertVecNear(firstDiagonalTangent, secondDiagonalTangent);

    assertUnitVector(firstSharedTangent);
    assertUnitVector(readBitangent(commands, 0));
  });

  void test('keeps tangent and bitangent finite on degenerate uv triangles', () => {
    const commands = [
      ...createVertex(0.0, 0.0, 0.0, 0.5, 0.5),
      ...createVertex(1.0, 0.0, 0.0, 0.5, 0.5),
      ...createVertex(0.0, 1.0, 0.0, 0.5, 0.5),
    ];

    Mesh.CalculateTangentBitangents(commands, commands.length);

    const tangent = readTangent(commands, 0);
    const bitangent = readBitangent(commands, 0);

    for (const component of [...tangent, ...bitangent]) {
      assert.ok(Number.isFinite(component));
    }
  });
});
