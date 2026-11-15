import { Quaternion } from '../../../shared/Vector.ts';
import { SkeletalModel, type SkeletalMeshData } from './SkeletalModel.ts';

/** The inverse bind matrices of a model, and how many joints could not be inverted. */
export interface InverseBindResult {
  /** `jointCount * MATRIX_FLOATS` numbers. A joint that cannot be inverted gets the identity. */
  readonly matrices: Float32Array;
  /** Joints whose rest pose has a zero scale on some axis. Their matrices are the identity. */
  readonly singularJoints: number;
}

/**
 * Numbers in a local pose: translation `x, y, z`, rotation `w, x, y, z`, scale `x, y, z`. Equal to
 * `SkeletalModel.POSE_FLOATS`, which this module cannot read while it is evaluated (`SkeletalModel` imports `Mod`, which
 * imports the loaders, which import this file), so `computePose` asserts that they agree.
 */
const LOCAL_POSE_FLOATS = 10;

/**
 * Poses a `SkeletalModel`: interpolates the stored frames and composes the joint hierarchy into matrices.
 * Free of GL, so the server uses it for tags and the client for skinning.
 *
 * Matrices are 3×4, row major (`Quaternion.toMatrix3x4Into`): three rows of `[column 0, column 1, column 2,
 * translation]`, with the bottom row `0, 0, 0, 1` implied. A joint's matrix is its parent's matrix times its own
 * local transform (translation, then rotation, then scale), so a joint can carry non-uniform scale, which a
 * translation-plus-quaternion chain could not represent.
 *
 * Nothing here allocates: the caller owns the output arrays, and the scratch space is shared by all calls (a
 * pose is always finished before the next one starts).
 */
export class SkeletalAnimation {
  /** Numbers per joint in the matrix arrays (a 3×4 matrix). */
  static readonly MATRIX_FLOATS = 12;

  /** The interpolated local pose of the joint being composed: translation, rotation, scale. */
  static readonly #localPose = new Float32Array(LOCAL_POSE_FLOATS);

  /** The local matrix of the joint being composed. */
  static readonly #localMatrix = new Float32Array(SkeletalAnimation.MATRIX_FLOATS);

  /** The product of a matrix multiplication, so that the output may alias an input. */
  static readonly #product = new Float32Array(SkeletalAnimation.MATRIX_FLOATS);

  /**
   * Computes the matrix of every joint in model space for a pose between two frames, and optionally the
   * skinning matrices (joint matrix times inverse bind matrix) that move a bind pose vertex to its place.
   *
   * Both frame indexes are clamped to the model's frames (a frame number off the wire is not trusted) and the
   * blend to [0, 1]. Translation and scale are interpolated linearly and rotation along the shortest path
   * (`Quaternion.slerpInto`), the same call tags use.
   * @param model The model to pose.
   * @param frameA First frame.
   * @param frameB Second frame.
   * @param blend Weight of `frameB`: 0 gives `frameA`, 1 gives `frameB`.
   * @param outJointMatrices Receives `jointCount * MATRIX_FLOATS` numbers.
   * @param outSkinningMatrices Receives the same count, or `null` when only joints are needed (tags).
   */
  static computePose(
    model: SkeletalModel,
    frameA: number,
    frameB: number,
    blend: number,
    outJointMatrices: Float32Array,
    outSkinningMatrices: Float32Array | null,
  ): void {
    const { jointCount, jointParents, framePoses, inverseBindMatrices } = model;
    console.assert(outJointMatrices.length >= jointCount * SkeletalAnimation.MATRIX_FLOATS, 'joint matrix buffer too small');
    console.assert(outSkinningMatrices === null || outSkinningMatrices.length >= jointCount * SkeletalAnimation.MATRIX_FLOATS, 'skinning matrix buffer too small');
    console.assert(Number.isFinite(blend), 'finite blend');
    console.assert(LOCAL_POSE_FLOATS === SkeletalModel.POSE_FLOATS, 'pose layout changed');

    const lastFrame = model.frameCount - 1;
    const poseFloats = SkeletalModel.POSE_FLOATS;
    const matrixFloats = SkeletalAnimation.MATRIX_FLOATS;
    const offsetA = Math.min(Math.max(Math.trunc(frameA), 0), lastFrame) * jointCount * poseFloats;
    const offsetB = Math.min(Math.max(Math.trunc(frameB), 0), lastFrame) * jointCount * poseFloats;
    const weight = Math.min(Math.max(blend, 0.0), 1.0);
    const pose = SkeletalAnimation.#localPose;
    const localMatrix = SkeletalAnimation.#localMatrix;

    for (let joint = 0; joint < jointCount; joint++) {
      const poseOffset = joint * poseFloats;
      SkeletalAnimation.#interpolateLocalPose(pose, framePoses, offsetA + poseOffset, offsetB + poseOffset, weight);
      Quaternion.toMatrix3x4Into(localMatrix, 0, pose, 3, pose, 0, pose, 7);

      const matrixOffset = joint * matrixFloats;
      const parent = jointParents[joint];

      if (parent < 0) {
        outJointMatrices.set(localMatrix, matrixOffset);
      } else {
        SkeletalAnimation.multiplyMatrix3x4Into(outJointMatrices, matrixOffset, outJointMatrices, parent * matrixFloats, localMatrix, 0);
      }

      if (outSkinningMatrices !== null) {
        SkeletalAnimation.multiplyMatrix3x4Into(outSkinningMatrices, matrixOffset, outJointMatrices, matrixOffset, inverseBindMatrices, matrixOffset);
      }
    }
  }

  /**
   * Skins every vertex of a mesh on the CPU: each position and normal is moved by the skinning matrices of its (up to
   * four) joints and blended by their weights. Normals are moved by the rotation part of the matrices and brought back
   * to unit length, so a joint with scale does not leave them too long or too short (a normal that cancels out becomes +Z).
   *
   * The result goes into one interleaved array, so a renderer can upload it as it is: vertex `index` has its position
   * at `index * stride + positionOffset` and its normal at `index * stride + normalOffset`. Nothing else in the array is
   * touched (texture coordinates stay where the renderer put them).
   * @param meshData The bind pose mesh.
   * @param skinningMatrices The skinning matrices of one pose (`computePose`).
   * @param out Receives the skinned vertices.
   * @param stride Numbers per vertex in `out`.
   * @param positionOffset Index of the position within a vertex.
   * @param normalOffset Index of the normal within a vertex.
   */
  static skinMeshInto(
    meshData: SkeletalMeshData,
    skinningMatrices: Float32Array,
    out: Float32Array,
    stride: number,
    positionOffset: number,
    normalOffset: number,
  ): void {
    const { positions, normals, blendIndexes, blendWeights } = meshData;
    const vertexCount = positions.length / 3;
    console.assert(out.length >= vertexCount * stride, 'skinned vertex buffer too small');

    for (let vertex = 0; vertex < vertexCount; vertex++) {
      const x = positions[vertex * 3];
      const y = positions[vertex * 3 + 1];
      const z = positions[vertex * 3 + 2];
      const nx = normals[vertex * 3];
      const ny = normals[vertex * 3 + 1];
      const nz = normals[vertex * 3 + 2];

      let skinnedX = 0.0;
      let skinnedY = 0.0;
      let skinnedZ = 0.0;
      let skinnedNormalX = 0.0;
      let skinnedNormalY = 0.0;
      let skinnedNormalZ = 0.0;

      for (let influence = 0; influence < 4; influence++) {
        const weight = blendWeights[vertex * 4 + influence];

        if (weight === 0.0) {
          continue;
        }

        const matrix = blendIndexes[vertex * 4 + influence] * SkeletalAnimation.MATRIX_FLOATS;
        skinnedX += weight * (skinningMatrices[matrix] * x + skinningMatrices[matrix + 1] * y + skinningMatrices[matrix + 2] * z + skinningMatrices[matrix + 3]);
        skinnedY += weight * (skinningMatrices[matrix + 4] * x + skinningMatrices[matrix + 5] * y + skinningMatrices[matrix + 6] * z + skinningMatrices[matrix + 7]);
        skinnedZ += weight * (skinningMatrices[matrix + 8] * x + skinningMatrices[matrix + 9] * y + skinningMatrices[matrix + 10] * z + skinningMatrices[matrix + 11]);
        skinnedNormalX += weight * (skinningMatrices[matrix] * nx + skinningMatrices[matrix + 1] * ny + skinningMatrices[matrix + 2] * nz);
        skinnedNormalY += weight * (skinningMatrices[matrix + 4] * nx + skinningMatrices[matrix + 5] * ny + skinningMatrices[matrix + 6] * nz);
        skinnedNormalZ += weight * (skinningMatrices[matrix + 8] * nx + skinningMatrices[matrix + 9] * ny + skinningMatrices[matrix + 10] * nz);
      }

      const length = Math.sqrt(skinnedNormalX * skinnedNormalX + skinnedNormalY * skinnedNormalY + skinnedNormalZ * skinnedNormalZ);
      const position = vertex * stride + positionOffset;
      const normal = vertex * stride + normalOffset;

      out[position] = skinnedX;
      out[position + 1] = skinnedY;
      out[position + 2] = skinnedZ;

      if (length > 1e-12) {
        out[normal] = skinnedNormalX / length;
        out[normal + 1] = skinnedNormalY / length;
        out[normal + 2] = skinnedNormalZ / length;
      } else {
        // The weighted normals cancel out (or a joint has no scale): a shader cannot normalize nothing.
        out[normal] = 0.0;
        out[normal + 1] = 0.0;
        out[normal + 2] = 1.0;
      }
    }
  }

  /**
   * Writes the local pose of one joint between two frames of `framePoses`.
   * @param out Receives `POSE_FLOATS` numbers at 0.
   * @param framePoses The model's decoded frames.
   * @param offsetA Index of the joint's pose in the first frame.
   * @param offsetB Index of the joint's pose in the second frame.
   * @param weight Weight of the second frame in [0, 1].
   */
  static #interpolateLocalPose(out: Float32Array, framePoses: Float32Array, offsetA: number, offsetB: number, weight: number): void {
    if (weight === 0.0 || offsetA === offsetB) {
      for (let index = 0; index < SkeletalModel.POSE_FLOATS; index++) {
        out[index] = framePoses[offsetA + index];
      }
      return;
    }

    for (let index = 0; index < 3; index++) {
      out[index] = framePoses[offsetA + index] + (framePoses[offsetB + index] - framePoses[offsetA + index]) * weight;
      out[7 + index] = framePoses[offsetA + 7 + index] + (framePoses[offsetB + 7 + index] - framePoses[offsetA + 7 + index]) * weight;
    }

    Quaternion.slerpInto(out, 3, framePoses, offsetA + 3, framePoses, offsetB + 3, weight);
  }

  /**
   * Computes the inverse of every joint's bind pose matrix, which a model needs once, at load.
   * @param restPose The model's rest pose, `POSE_FLOATS` numbers per joint.
   * @param jointParents The parent of every joint, parents before children.
   * @returns The matrices and the number of joints that could not be inverted.
   */
  static computeInverseBindMatrices(restPose: Float32Array, jointParents: Int32Array): InverseBindResult {
    const matrixFloats = SkeletalAnimation.MATRIX_FLOATS;
    const jointCount = jointParents.length;
    const bind = new Float32Array(jointCount * matrixFloats);
    const matrices = new Float32Array(jointCount * matrixFloats);
    let singularJoints = 0;

    for (let joint = 0; joint < jointCount; joint++) {
      const poseOffset = joint * SkeletalModel.POSE_FLOATS;
      const matrixOffset = joint * matrixFloats;
      const parent = jointParents[joint];

      Quaternion.toMatrix3x4Into(bind, matrixOffset, restPose, poseOffset + 3, restPose, poseOffset, restPose, poseOffset + 7);

      if (parent >= 0) {
        const local = bind.slice(matrixOffset, matrixOffset + matrixFloats);
        SkeletalAnimation.multiplyMatrix3x4Into(bind, matrixOffset, bind, parent * matrixFloats, local, 0);
      }

      if (!SkeletalAnimation.invertMatrix3x4Into(matrices, matrixOffset, bind, matrixOffset)) {
        singularJoints++;
        SkeletalAnimation.writeIdentity(matrices, matrixOffset);
      }
    }

    return { matrices, singularJoints };
  }

  /**
   * Writes the identity transform.
   * @param out Array receiving the 12 numbers.
   * @param outOffset Index of the first.
   */
  static writeIdentity(out: Float32Array, outOffset: number): void {
    out.fill(0.0, outOffset, outOffset + SkeletalAnimation.MATRIX_FLOATS);
    out[outOffset] = 1.0;
    out[outOffset + 5] = 1.0;
    out[outOffset + 10] = 1.0;
  }

  /**
   * Multiplies two 3×4 matrices as if they were 4×4 with a bottom row of `0, 0, 0, 1`: the transform `right`
   * applied first, then `left`. `out` may be the same array and offset as either input.
   * @param out Array receiving the 12 numbers.
   * @param outOffset Index of the first.
   * @param left Array holding the left matrix.
   * @param leftOffset Index of its first number.
   * @param right Array holding the right matrix.
   * @param rightOffset Index of its first number.
   */
  static multiplyMatrix3x4Into(
    out: Float32Array, outOffset: number,
    left: ArrayLike<number>, leftOffset: number,
    right: ArrayLike<number>, rightOffset: number,
  ): void {
    const product = SkeletalAnimation.#product;

    for (let row = 0; row < 3; row++) {
      const l0 = left[leftOffset + row * 4];
      const l1 = left[leftOffset + row * 4 + 1];
      const l2 = left[leftOffset + row * 4 + 2];
      const l3 = left[leftOffset + row * 4 + 3];

      for (let column = 0; column < 3; column++) {
        product[row * 4 + column] = l0 * right[rightOffset + column] + l1 * right[rightOffset + 4 + column] + l2 * right[rightOffset + 8 + column];
      }

      product[row * 4 + 3] = l0 * right[rightOffset + 3] + l1 * right[rightOffset + 7] + l2 * right[rightOffset + 11] + l3;
    }

    out.set(product, outOffset);
  }

  /**
   * Inverts a 3×4 affine matrix (any 3×3 part, so non-uniform scale and shear are handled).
   * `out` may be the same array and offset as the input.
   * @param out Array receiving the 12 numbers. Untouched when the matrix cannot be inverted.
   * @param outOffset Index of the first.
   * @param matrix Array holding the matrix.
   * @param matrixOffset Index of its first number.
   * @returns `false` when the matrix is singular (a zero scale), `true` otherwise.
   */
  static invertMatrix3x4Into(out: Float32Array, outOffset: number, matrix: ArrayLike<number>, matrixOffset: number): boolean {
    const m00 = matrix[matrixOffset];
    const m01 = matrix[matrixOffset + 1];
    const m02 = matrix[matrixOffset + 2];
    const tx = matrix[matrixOffset + 3];
    const m10 = matrix[matrixOffset + 4];
    const m11 = matrix[matrixOffset + 5];
    const m12 = matrix[matrixOffset + 6];
    const ty = matrix[matrixOffset + 7];
    const m20 = matrix[matrixOffset + 8];
    const m21 = matrix[matrixOffset + 9];
    const m22 = matrix[matrixOffset + 10];
    const tz = matrix[matrixOffset + 11];

    const c00 = m11 * m22 - m12 * m21;
    const c01 = m12 * m20 - m10 * m22;
    const c02 = m10 * m21 - m11 * m20;
    const determinant = m00 * c00 + m01 * c01 + m02 * c02;

    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) {
      return false;
    }

    const inverseDeterminant = 1.0 / determinant;
    const i00 = c00 * inverseDeterminant;
    const i01 = (m02 * m21 - m01 * m22) * inverseDeterminant;
    const i02 = (m01 * m12 - m02 * m11) * inverseDeterminant;
    const i10 = c01 * inverseDeterminant;
    const i11 = (m00 * m22 - m02 * m20) * inverseDeterminant;
    const i12 = (m02 * m10 - m00 * m12) * inverseDeterminant;
    const i20 = c02 * inverseDeterminant;
    const i21 = (m01 * m20 - m00 * m21) * inverseDeterminant;
    const i22 = (m00 * m11 - m01 * m10) * inverseDeterminant;

    out[outOffset] = i00;
    out[outOffset + 1] = i01;
    out[outOffset + 2] = i02;
    out[outOffset + 3] = -(i00 * tx + i01 * ty + i02 * tz);
    out[outOffset + 4] = i10;
    out[outOffset + 5] = i11;
    out[outOffset + 6] = i12;
    out[outOffset + 7] = -(i10 * tx + i11 * ty + i12 * tz);
    out[outOffset + 8] = i20;
    out[outOffset + 9] = i21;
    out[outOffset + 10] = i22;
    out[outOffset + 11] = -(i20 * tx + i21 * ty + i22 * tz);
    return true;
  }
}
