import Vector from '../../../../shared/Vector.ts';
import { CorruptedResourceError } from '../../Errors.ts';
import { IQMModel } from '../IQMModel.ts';
import { ModelLoader } from '../ModelLoader.ts';
import { SkeletalAnimation } from '../SkeletalAnimation.ts';
import { SkeletalMaterialLoader } from '../SkeletalMaterialLoader.ts';
import type { SkeletalMaterial, SkeletalMeshData, SkeletalMeshRange, SkeletalSequence } from '../SkeletalModel.ts';
import { SkeletalModel } from '../SkeletalModel.ts';

/** `INTERQUAKEMODEL` and a terminating zero. */
const IQM_MAGIC = 'INTERQUAKEMODEL\0';

/** The first four bytes of the magic as a little-endian number, `"INTE"`. */
const IQM_MAGIC_NUMBER = 0x45544e49;

const IQM_VERSION = 2;

const IQM_HEADER_BYTES = 124;
const IQM_MESH_BYTES = 24;
const IQM_VERTEX_ARRAY_BYTES = 20;
const IQM_TRIANGLE_BYTES = 12;
const IQM_JOINT_BYTES = 48;
const IQM_POSE_BYTES = 88;
const IQM_ANIM_BYTES = 20;
const IQM_BOUNDS_BYTES = 32;

enum IQMVertexArrayType {
  position = 0,
  texcoord = 1,
  normal = 2,
  blendIndexes = 4,
  blendWeights = 5,
}

enum IQMComponentFormat {
  ubyte = 1,
  ushort = 3,
  uint = 5,
  float = 7,
}

/** `IQM_LOOP` in the flags of an animation. */
const IQM_ANIM_LOOP = 1;

/** Channels of a pose: translation, rotation (`x, y, z, w`) and scale. */
const IQM_CHANNELS = 10;

/**
 * Limits that keep a corrupted header from making the loader allocate memory the file does not back. Joint and
 * frame counts are tied to nothing in the file's size (a pose with no varying channel costs no frame data), so
 * they are capped on their own. The largest LibreQuake model (the shambler: 468 bones, 94 frames) uses a twentieth of the pose limit.
 */
const MAX_JOINTS = 4096;
const MAX_FRAMES = 65536;
const MAX_POSE_NUMBERS = 8_000_000;

/** The smallest length a stored rotation may have before it cannot be normalized. */
const MIN_QUATERNION_LENGTH = 1e-6;

interface IQMHeader {
  readonly textSize: number;
  readonly textOffset: number;
  readonly meshCount: number;
  readonly meshOffset: number;
  readonly vertexArrayCount: number;
  readonly vertexCount: number;
  readonly vertexArrayOffset: number;
  readonly triangleCount: number;
  readonly triangleOffset: number;
  readonly jointCount: number;
  readonly jointOffset: number;
  readonly poseCount: number;
  readonly poseOffset: number;
  readonly animCount: number;
  readonly animOffset: number;
  readonly frameCount: number;
  readonly frameChannelCount: number;
  readonly frameOffset: number;
  readonly boundsOffset: number;
}

interface IQMMesh {
  readonly name: string;
  readonly material: string;
  readonly firstVertex: number;
  readonly vertexCount: number;
  readonly firstTriangle: number;
  readonly triangleCount: number;
}

interface IQMVertexArray {
  readonly format: IQMComponentFormat;
  readonly size: number;
  readonly offset: number;
}

interface IQMVertexData {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly texcoords: Float32Array;
  readonly blendIndexes: Uint16Array;
  readonly blendWeights: Float32Array;
}

/**
 * Loader for Inter-Quake Model files (`.iqm`), version 2, the skeletal format of the engine.
 *
 * The file (all little-endian) starts with a 124 byte header: the magic `INTERQUAKEMODEL\0`, the version, the
 * file size, flags, then a count and an offset for the text table, meshes, vertex arrays (plus the vertex count),
 * triangles (plus an unused adjacency offset), joints, poses, animations, frames (plus the number of channels that
 * vary), the per-frame bounds, a comment and extensions. The layout was checked against FTE's reader
 * (`Mod_ParseIQMMeshModel` in `engine/common/com_mesh.c`) and the files of the `qs-tools` exporter.
 *
 * - **Meshes** name themselves and a material by offsets into the text table, and own a run of vertices and of
 *   triangles. Triangle indexes are global and must stay inside the mesh's own vertex run.
 * - **Vertex arrays** are typed: positions, normals and texture coordinates as floats, four joint indexes as
 *   `ubyte`, `ushort` or `uint`, four weights as `ubyte` (divided by 255) or float. Tangents, colors and custom
 *   arrays are skipped.
 * - **Joints** (v2) hold name, parent (`-1` for a root, otherwise lower than the joint itself), and the bind pose as
 *   translation, rotation (`x, y, z, w`) and scale.
 * - **Poses** hold, per joint, a mask of which of the ten channels vary and an offset and scale for each. **Frames**
 *   are `ushort` values for the varying channels only, joint after joint. `offset + value * scale` gives the channel.
 * - **Animations** name a run of frames with a frame rate and a loop flag.
 * - **Bounds** are per frame: minimum, maximum, radius around the Z axis, radius around the origin.
 *
 * Rotations are stored `x, y, z, w` in the file. They are reordered to the engine's `w, x, y, z` and normalized
 * here, once, and nowhere else. Weights are renormalized to sum to one.
 *
 * The file is untrusted. Every count and offset is checked against the size of the file before it is read, and a
 * problem throws `CorruptedResourceError`. A realm that does not draw reads and validates the vertex data like any
 * other, then keeps none of it (it keeps joints, poses, sequences and bounds, which tags and `setModel()` need).
 */
export class IQMLoader extends ModelLoader {
  override getMagicNumbers(): number[] {
    return [IQM_MAGIC_NUMBER];
  }

  override getExtensions(): string[] {
    return ['.iqm'];
  }

  override getName(): string {
    return 'Inter-Quake Model';
  }

  override canLoad(buffer: ArrayBuffer, filename: string): boolean {
    if (!super.canLoad(buffer, filename)) {
      return false;
    }

    return new TextDecoder('latin1').decode(new Uint8Array(buffer, 0, IQM_MAGIC.length)) === IQM_MAGIC;
  }

  override async load(buffer: ArrayBuffer, name: string): Promise<IQMModel> {
    const reader = new IQMReader(buffer, name);
    const header = reader.readHeader();
    const loadmodel = new IQMModel(name);

    const meshes = reader.readMeshes(header);
    const vertices = reader.readVertices(header);
    const triangles = reader.readTriangles(header, meshes);
    reader.validateBlendIndexes(vertices.blendIndexes, header.jointCount);

    const { names, parents, restPose } = reader.readJoints(header);
    const framePoses = reader.readFramePoses(header, restPose);
    const frameCount = header.frameCount === 0 ? 1 : header.frameCount;
    const frameBounds = this.#readBounds(reader, header, vertices.positions, frameCount);
    const sequences = reader.readSequences(header, frameCount);

    loadmodel.jointNames = names;
    loadmodel.jointParents = parents;
    loadmodel.restPose = restPose;
    loadmodel.framePoses = framePoses;

    const inverseBind = SkeletalAnimation.computeInverseBindMatrices(restPose, parents);
    loadmodel.inverseBindMatrices = inverseBind.matrices;

    if (inverseBind.singularJoints > 0) {
      this.context.con.DPrint(`IQMLoader: ${name} has ${inverseBind.singularJoints} joint(s) with a zero scale in the rest pose, vertices weighted to them are not skinned correctly\n`);
    }

    loadmodel.frameBounds = frameBounds;
    loadmodel.sequences = sequences;

    this.#applyBounds(loadmodel, frameBounds);

    loadmodel._num_frames = frameCount;
    loadmodel._num_skins = 1;
    loadmodel._num_verts = header.vertexCount;
    loadmodel._num_tris = header.triangleCount;

    if (this.context.loadRenderData) {
      const { materials, ranges } = this.#buildMeshRanges(meshes);

      loadmodel.materials = materials;
      loadmodel.meshes = ranges;
      loadmodel.meshData = { ...vertices, triangles } satisfies SkeletalMeshData;

      if (this.context.textures !== null) {
        await SkeletalMaterialLoader.load(materials, this.context.textures, this.context.con);
      }
    }

    loadmodel.needload = false;

    return loadmodel;
  }

  /**
   * Reads the per-frame bounds. A file that has frames but no bounds falls back to the bounds of the bind pose, which
   * is wrong for an animation that leaves it: the console says so.
   * @returns `frameCount * BOUNDS_FLOATS` numbers.
   */
  #readBounds(reader: IQMReader, header: IQMHeader, positions: Float32Array, frameCount: number): Float32Array {
    if (header.frameCount > 0 && header.boundsOffset !== 0) {
      return reader.readFrameBounds(header);
    }

    if (header.frameCount > 0) {
      this.context.con.DPrint(`IQMLoader: ${reader.name} has frames but no bounds, using the bounds of its bind pose\n`);
    }

    return IQMReader.boundsOfPositions(positions, frameCount);
  }

  /**
   * Sets the box and radius the game and the culling code read from the union of all frames.
   */
  #applyBounds(loadmodel: IQMModel, frameBounds: Float32Array): void {
    const stride = SkeletalModel.BOUNDS_FLOATS;
    const mins = [Infinity, Infinity, Infinity];
    const maxs = [-Infinity, -Infinity, -Infinity];
    let radius = 0;

    for (let offset = 0; offset < frameBounds.length; offset += stride) {
      for (let axis = 0; axis < 3; axis++) {
        mins[axis] = Math.min(mins[axis], frameBounds[offset + axis]);
        maxs[axis] = Math.max(maxs[axis], frameBounds[offset + 3 + axis]);
      }

      radius = Math.max(radius, frameBounds[offset + 7]);
    }

    loadmodel.mins = new Vector(...mins);
    loadmodel.maxs = new Vector(...maxs);
    loadmodel.boundingradius = radius;
  }

  /**
   * Gives every distinct material name an index, in the order the meshes use them.
   * @returns The materials and the mesh ranges that refer to them.
   */
  #buildMeshRanges(meshes: IQMMesh[]): { materials: SkeletalMaterial[]; ranges: SkeletalMeshRange[] } {
    const materials: SkeletalMaterial[] = [];
    const ranges: SkeletalMeshRange[] = [];

    for (const mesh of meshes) {
      let materialIndex = materials.findIndex((material) => material.name === mesh.material);

      if (materialIndex === -1) {
        materialIndex = materials.length;
        materials.push({ name: mesh.material, diffuse: null, glow: null, shirt: null, pants: null });
      }

      ranges.push({
        name: mesh.name,
        materialIndex,
        firstVertex: mesh.firstVertex,
        vertexCount: mesh.vertexCount,
        firstTriangle: mesh.firstTriangle,
        triangleCount: mesh.triangleCount,
      });
    }

    return { materials, ranges };
  }
}

/**
 * Bounds-checked access to the bytes of one IQM file.
 */
class IQMReader {
  readonly name: string;
  readonly #view: DataView;
  readonly #bytes: Uint8Array;
  #textSize = 0;

  constructor(buffer: ArrayBuffer, name: string) {
    this.name = name;
    this.#view = new DataView(buffer);
    this.#bytes = new Uint8Array(buffer);
  }

  /**
   * Bounds of a set of positions as `frameCount` identical entries of `BOUNDS_FLOATS` numbers.
   * @returns The bounds. A model without vertices has empty bounds at the origin.
   */
  static boundsOfPositions(positions: Float32Array, frameCount: number): Float32Array {
    const bounds = new Float32Array(frameCount * SkeletalModel.BOUNDS_FLOATS);

    if (positions.length === 0) {
      return bounds;
    }

    const mins = [Infinity, Infinity, Infinity];
    const maxs = [-Infinity, -Infinity, -Infinity];
    let radiusXY = 0;
    let radius = 0;

    for (let index = 0; index < positions.length; index += 3) {
      for (let axis = 0; axis < 3; axis++) {
        mins[axis] = Math.min(mins[axis], positions[index + axis]);
        maxs[axis] = Math.max(maxs[axis], positions[index + axis]);
      }

      radiusXY = Math.max(radiusXY, Math.hypot(positions[index], positions[index + 1]));
      radius = Math.max(radius, Math.hypot(positions[index], positions[index + 1], positions[index + 2]));
    }

    for (let frame = 0; frame < frameCount; frame++) {
      bounds.set([...mins, ...maxs, radiusXY, radius], frame * SkeletalModel.BOUNDS_FLOATS);
    }

    return bounds;
  }

  #fail(reason: string): never {
    throw new CorruptedResourceError(this.name, reason);
  }

  /**
   * Checks that `count` records of `size` bytes at `offset` lie inside the file.
   */
  #checkRegion(what: string, count: number, offset: number, size: number): void {
    if (offset + count * size > this.#view.byteLength) {
      this.#fail(`${what} (${count} entries at offset ${offset}) lie outside the file of ${this.#view.byteLength} bytes`);
    }
  }

  #u32(offset: number): number {
    return this.#view.getUint32(offset, true);
  }

  #i32(offset: number): number {
    return this.#view.getInt32(offset, true);
  }

  #f32(offset: number): number {
    return this.#view.getFloat32(offset, true);
  }

  /**
   * Reads and checks the header.
   * @returns The counts and offsets of the file.
   */
  readHeader(): IQMHeader {
    if (this.#view.byteLength < IQM_HEADER_BYTES) {
      this.#fail(`the file has ${this.#view.byteLength} bytes, the header alone needs ${IQM_HEADER_BYTES}`);
    }

    const version = this.#u32(16);

    if (version !== IQM_VERSION) {
      this.#fail(`IQM version ${version} is not supported, only version ${IQM_VERSION}`);
    }

    const fileSize = this.#u32(20);

    if (fileSize !== this.#view.byteLength) {
      this.#fail(`the header says ${fileSize} bytes, the file has ${this.#view.byteLength}`);
    }

    const header: IQMHeader = {
      textSize: this.#u32(28),
      textOffset: this.#u32(32),
      meshCount: this.#u32(36),
      meshOffset: this.#u32(40),
      vertexArrayCount: this.#u32(44),
      vertexCount: this.#u32(48),
      vertexArrayOffset: this.#u32(52),
      triangleCount: this.#u32(56),
      triangleOffset: this.#u32(60),
      jointCount: this.#u32(68),
      jointOffset: this.#u32(72),
      poseCount: this.#u32(76),
      poseOffset: this.#u32(80),
      animCount: this.#u32(84),
      animOffset: this.#u32(88),
      frameCount: this.#u32(92),
      frameChannelCount: this.#u32(96),
      frameOffset: this.#u32(100),
      boundsOffset: this.#u32(104),
    };

    this.#checkRegion('the text table', header.textSize, header.textOffset, 1);
    this.#textSize = header.textSize;

    if (header.jointCount === 0 || header.jointCount > MAX_JOINTS) {
      this.#fail(`${header.jointCount} joints (a skeletal model needs 1 to ${MAX_JOINTS})`);
    }

    if (header.frameCount > MAX_FRAMES || Math.max(header.frameCount, 1) * header.jointCount * IQM_CHANNELS > MAX_POSE_NUMBERS) {
      this.#fail(`${header.frameCount} frames of ${header.jointCount} joints are more than the loader accepts`);
    }

    if (header.meshCount === 0 || header.vertexCount === 0 || header.triangleCount === 0) {
      this.#fail('the model has no mesh, vertices or triangles');
    }

    return header;
  }

  /**
   * Reads a string out of the text table.
   * @returns The string, which ends at the next zero byte.
   */
  #string(textOffset: number, offset: number, what: string): string {
    if (offset >= this.#textSize) {
      this.#fail(`${what} points to offset ${offset} of a text table of ${this.#textSize} bytes`);
    }

    const start = textOffset + offset;
    const end = textOffset + this.#textSize;
    let stop = start;

    while (stop < end && this.#bytes[stop] !== 0) {
      stop++;
    }

    if (stop === end) {
      this.#fail(`${what} is not terminated inside the text table`);
    }

    return new TextDecoder('utf-8').decode(this.#bytes.subarray(start, stop));
  }

  readMeshes(header: IQMHeader): IQMMesh[] {
    this.#checkRegion('the meshes', header.meshCount, header.meshOffset, IQM_MESH_BYTES);

    const meshes: IQMMesh[] = [];

    for (let index = 0; index < header.meshCount; index++) {
      const offset = header.meshOffset + index * IQM_MESH_BYTES;
      const mesh: IQMMesh = {
        name: this.#string(header.textOffset, this.#u32(offset), `the name of mesh ${index}`),
        material: this.#string(header.textOffset, this.#u32(offset + 4), `the material of mesh ${index}`),
        firstVertex: this.#u32(offset + 8),
        vertexCount: this.#u32(offset + 12),
        firstTriangle: this.#u32(offset + 16),
        triangleCount: this.#u32(offset + 20),
      };

      if (mesh.firstVertex + mesh.vertexCount > header.vertexCount) {
        this.#fail(`mesh ${index} leaves the ${header.vertexCount} vertices of the model`);
      }

      if (mesh.firstTriangle + mesh.triangleCount > header.triangleCount) {
        this.#fail(`mesh ${index} leaves the ${header.triangleCount} triangles of the model`);
      }

      meshes.push(mesh);
    }

    return meshes;
  }

  /**
   * Reads the vertex arrays the engine uses and checks them.
   * @returns The arrays, weights renormalized to sum to one.
   */
  readVertices(header: IQMHeader): IQMVertexData {
    this.#checkRegion('the vertex arrays', header.vertexArrayCount, header.vertexArrayOffset, IQM_VERTEX_ARRAY_BYTES);

    const arrays = new Map<number, IQMVertexArray>();

    for (let index = 0; index < header.vertexArrayCount; index++) {
      const offset = header.vertexArrayOffset + index * IQM_VERTEX_ARRAY_BYTES;
      arrays.set(this.#u32(offset), { format: this.#u32(offset + 8) as IQMComponentFormat, size: this.#u32(offset + 12), offset: this.#u32(offset + 16) });
    }

    const count = header.vertexCount;
    const positions = this.#floatArray(arrays, IQMVertexArrayType.position, 3, count, 'positions');
    const normals = this.#floatArray(arrays, IQMVertexArrayType.normal, 3, count, 'normals');
    const texcoords = this.#floatArray(arrays, IQMVertexArrayType.texcoord, 2, count, 'texture coordinates');
    const blendIndexes = this.#blendIndexes(arrays, count);
    const blendWeights = this.#blendWeights(arrays, count);

    for (let index = 0; index < positions.length; index++) {
      if (!Number.isFinite(positions[index])) {
        this.#fail(`vertex ${Math.floor(index / 3)} has a position that is not a number`);
      }
    }

    return { positions, normals, texcoords, blendIndexes, blendWeights };
  }

  #findArray(arrays: Map<number, IQMVertexArray>, type: number, size: number, what: string) {
    const array = arrays.get(type);

    if (array === undefined) {
      this.#fail(`the model has no ${what}`);
    }

    if (array.size !== size) {
      this.#fail(`the ${what} have ${array.size} components, ${size} are needed`);
    }

    return array;
  }

  #floatArray(arrays: Map<number, IQMVertexArray>, type: number, size: number, count: number, what: string): Float32Array {
    const array = this.#findArray(arrays, type, size, what);

    if (array.format !== IQMComponentFormat.float) {
      this.#fail(`the ${what} are not stored as floats (format ${array.format})`);
    }

    this.#checkRegion(`the ${what}`, count * size, array.offset, 4);

    const values = new Float32Array(count * size);

    for (let index = 0; index < values.length; index++) {
      values[index] = this.#f32(array.offset + index * 4);
    }

    return values;
  }

  #blendIndexes(arrays: Map<number, IQMVertexArray>, count: number): Uint16Array {
    const array = this.#findArray(arrays, IQMVertexArrayType.blendIndexes, 4, 'blend indexes');
    const width = this.#blendIndexWidth(array.format);

    this.#checkRegion('the blend indexes', count * 4, array.offset, width);

    const values = new Uint16Array(count * 4);

    for (let index = 0; index < values.length; index++) {
      const offset = array.offset + index * width;
      const value = width === 1 ? this.#view.getUint8(offset) : width === 2 ? this.#view.getUint16(offset, true) : this.#u32(offset);

      if (value > 0xffff) {
        this.#fail(`blend index ${value} does not fit a joint index`);
      }

      values[index] = value;
    }

    return values;
  }

  #blendIndexWidth(format: IQMComponentFormat): number {
    switch (format) {
      case IQMComponentFormat.ubyte:
        return 1;
      case IQMComponentFormat.ushort:
        return 2;
      case IQMComponentFormat.uint:
        return 4;
      default:
        return this.#fail(`the blend indexes have format ${format}, only ubyte, ushort and uint are supported`);
    }
  }

  #blendWeights(arrays: Map<number, IQMVertexArray>, count: number): Float32Array {
    const array = this.#findArray(arrays, IQMVertexArrayType.blendWeights, 4, 'blend weights');

    if (array.format !== IQMComponentFormat.ubyte && array.format !== IQMComponentFormat.float) {
      this.#fail(`the blend weights have format ${array.format}, only ubyte and float are supported`);
    }

    const width = array.format === IQMComponentFormat.ubyte ? 1 : 4;

    this.#checkRegion('the blend weights', count * 4, array.offset, width);

    const weights = new Float32Array(count * 4);

    for (let vertex = 0; vertex < count; vertex++) {
      let sum = 0;

      for (let influence = 0; influence < 4; influence++) {
        const offset = array.offset + (vertex * 4 + influence) * width;
        const weight = width === 1 ? this.#view.getUint8(offset) / 255 : this.#f32(offset);

        if (!(weight >= 0)) {
          this.#fail(`vertex ${vertex} has a negative weight`);
        }

        weights[vertex * 4 + influence] = weight;
        sum += weight;
      }

      if (!(sum > 0) || !Number.isFinite(sum)) {
        this.#fail(`vertex ${vertex} has no weight`);
      }

      for (let influence = 0; influence < 4; influence++) {
        weights[vertex * 4 + influence] /= sum;
      }
    }

    return weights;
  }

  /**
   * Makes sure every blend index names a joint.
   */
  validateBlendIndexes(blendIndexes: Uint16Array, jointCount: number): void {
    for (let index = 0; index < blendIndexes.length; index++) {
      if (blendIndexes[index] >= jointCount) {
        this.#fail(`vertex ${Math.floor(index / 4)} is skinned to joint ${blendIndexes[index]} of ${jointCount}`);
      }
    }
  }

  /**
   * Reads the triangles and checks that each stays inside the vertices of its mesh.
   * @returns Three vertex indexes per triangle.
   */
  readTriangles(header: IQMHeader, meshes: IQMMesh[]): Uint32Array {
    this.#checkRegion('the triangles', header.triangleCount, header.triangleOffset, IQM_TRIANGLE_BYTES);

    const triangles = new Uint32Array(header.triangleCount * 3);

    for (let index = 0; index < triangles.length; index++) {
      triangles[index] = this.#u32(header.triangleOffset + index * 4);
    }

    for (const [meshIndex, mesh] of meshes.entries()) {
      const end = (mesh.firstTriangle + mesh.triangleCount) * 3;

      for (let index = mesh.firstTriangle * 3; index < end; index++) {
        if (triangles[index] < mesh.firstVertex || triangles[index] >= mesh.firstVertex + mesh.vertexCount) {
          this.#fail(`triangle ${Math.floor(index / 3)} of mesh ${meshIndex} uses vertex ${triangles[index]}, outside the mesh's vertices ${mesh.firstVertex} to ${mesh.firstVertex + mesh.vertexCount - 1}`);
        }
      }
    }

    return triangles;
  }

  /**
   * Writes a pose of one joint (`x, y, z, w` rotation as stored in the file) in the engine's layout.
   */
  #writePose(out: Float32Array, base: number, channels: number[], what: string): void {
    const length = Math.hypot(channels[3], channels[4], channels[5], channels[6]);

    if (!(length > MIN_QUATERNION_LENGTH)) {
      this.#fail(`${what} has a rotation that cannot be normalized`);
    }

    out[base] = channels[0];
    out[base + 1] = channels[1];
    out[base + 2] = channels[2];
    out[base + 3] = channels[6] / length;
    out[base + 4] = channels[3] / length;
    out[base + 5] = channels[4] / length;
    out[base + 6] = channels[5] / length;
    out[base + 7] = channels[7];
    out[base + 8] = channels[8];
    out[base + 9] = channels[9];

    for (let index = 0; index < SkeletalModel.POSE_FLOATS; index++) {
      if (!Number.isFinite(out[base + index])) {
        this.#fail(`${what} has a value that is not a number`);
      }
    }
  }

  /**
   * Reads the joints.
   * @returns Names, parents (lower than the joint itself) and the bind pose.
   */
  readJoints(header: IQMHeader): { names: string[]; parents: Int32Array; restPose: Float32Array } {
    this.#checkRegion('the joints', header.jointCount, header.jointOffset, IQM_JOINT_BYTES);

    const names: string[] = [];
    const parents = new Int32Array(header.jointCount);
    const restPose = new Float32Array(header.jointCount * SkeletalModel.POSE_FLOATS);

    for (let joint = 0; joint < header.jointCount; joint++) {
      const offset = header.jointOffset + joint * IQM_JOINT_BYTES;
      const parent = this.#i32(offset + 4);

      if (parent < -1 || parent >= joint) {
        this.#fail(`joint ${joint} has parent ${parent}, a parent must come before its children`);
      }

      names.push(this.#string(header.textOffset, this.#u32(offset), `the name of joint ${joint}`));
      parents[joint] = parent;

      const channels: number[] = [];

      for (let channel = 0; channel < IQM_CHANNELS; channel++) {
        channels.push(this.#f32(offset + 8 + channel * 4));
      }

      this.#writePose(restPose, joint * SkeletalModel.POSE_FLOATS, channels, `joint ${joint}`);
    }

    return { names, parents, restPose };
  }

  /**
   * Decodes every frame into poses. A model without frames has one, its bind pose.
   * @returns `frames * jointCount * POSE_FLOATS` numbers.
   */
  readFramePoses(header: IQMHeader, restPose: Float32Array): Float32Array {
    if (header.frameCount === 0) {
      return restPose.slice();
    }

    if (header.poseCount !== header.jointCount) {
      this.#fail(`${header.poseCount} poses for ${header.jointCount} joints`);
    }

    this.#checkRegion('the poses', header.poseCount, header.poseOffset, IQM_POSE_BYTES);
    this.#checkRegion('the frames', header.frameCount * header.frameChannelCount, header.frameOffset, 2);

    const masks = new Uint32Array(header.poseCount);
    let channelsPerFrame = 0;

    for (let pose = 0; pose < header.poseCount; pose++) {
      masks[pose] = this.#u32(header.poseOffset + pose * IQM_POSE_BYTES + 4);

      if (masks[pose] >= 1 << IQM_CHANNELS) {
        this.#fail(`pose ${pose} has an invalid channel mask`);
      }

      for (let channel = 0; channel < IQM_CHANNELS; channel++) {
        channelsPerFrame += (masks[pose] >> channel) & 1;
      }
    }

    if (channelsPerFrame !== header.frameChannelCount) {
      this.#fail(`the header says ${header.frameChannelCount} frame channels, the poses add up to ${channelsPerFrame}`);
    }

    const poses = new Float32Array(header.frameCount * header.jointCount * SkeletalModel.POSE_FLOATS);
    const channels: number[] = new Array<number>(IQM_CHANNELS).fill(0);
    let cursor = header.frameOffset;

    for (let frame = 0; frame < header.frameCount; frame++) {
      for (let pose = 0; pose < header.poseCount; pose++) {
        const poseOffset = header.poseOffset + pose * IQM_POSE_BYTES;

        for (let channel = 0; channel < IQM_CHANNELS; channel++) {
          channels[channel] = this.#f32(poseOffset + 8 + channel * 4);

          if ((masks[pose] >> channel) & 1) {
            channels[channel] += this.#view.getUint16(cursor, true) * this.#f32(poseOffset + 48 + channel * 4);
            cursor += 2;
          }
        }

        this.#writePose(poses, (frame * header.jointCount + pose) * SkeletalModel.POSE_FLOATS, channels, `joint ${pose} in frame ${frame}`);
      }
    }

    return poses;
  }

  /**
   * Reads the bounds of every frame.
   * @returns `frameCount * BOUNDS_FLOATS` numbers.
   */
  readFrameBounds(header: IQMHeader): Float32Array {
    this.#checkRegion('the frame bounds', header.frameCount, header.boundsOffset, IQM_BOUNDS_BYTES);

    const bounds = new Float32Array(header.frameCount * SkeletalModel.BOUNDS_FLOATS);

    for (let index = 0; index < bounds.length; index++) {
      bounds[index] = this.#f32(header.boundsOffset + index * 4);

      if (!Number.isFinite(bounds[index])) {
        this.#fail(`the bounds of frame ${Math.floor(index / SkeletalModel.BOUNDS_FLOATS)} are not numbers`);
      }
    }

    return bounds;
  }

  /**
   * Reads the animations as sequences.
   * @returns The sequences, in file order.
   */
  readSequences(header: IQMHeader, frameCount: number): SkeletalSequence[] {
    this.#checkRegion('the animations', header.animCount, header.animOffset, IQM_ANIM_BYTES);

    const sequences: SkeletalSequence[] = [];

    for (let index = 0; index < header.animCount; index++) {
      const offset = header.animOffset + index * IQM_ANIM_BYTES;
      const firstFrame = this.#u32(offset + 4);
      const count = this.#u32(offset + 8);
      const framerate = this.#f32(offset + 12);
      const name = this.#string(header.textOffset, this.#u32(offset), `the name of animation ${index}`);

      if (count === 0 || firstFrame + count > frameCount) {
        this.#fail(`animation ${name} (frames ${firstFrame} to ${firstFrame + count - 1}) leaves the ${frameCount} frames of the model`);
      }

      if (!(framerate >= 0) || !Number.isFinite(framerate)) {
        this.#fail(`animation ${name} has frame rate ${framerate}`);
      }

      sequences.push({ name, firstFrame, frameCount: count, framerate, loop: (this.#u32(offset + 16) & IQM_ANIM_LOOP) !== 0 });
    }

    return sequences;
  }
}
