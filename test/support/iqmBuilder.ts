/**
 * Builds Inter-Quake Model v2 files for tests, from the format as FTE's `struct iqm*` definitions list it (an
 * independent writer: nothing here reads or shares code with `IQMLoader`). A test describes joints, frames, vertices
 * and meshes in the engine's own terms, rotations `w, x, y, z`, and gets the bytes. `patchHeader` damages one header
 * field by name to test how the loader treats a corrupted file.
 */

/** Translation `x, y, z`, rotation `w, x, y, z`, scale `x, y, z`. */
export type IqmPose = readonly number[];

export interface IqmJointSpec {
  readonly name: string;
  readonly parent: number;
  readonly pose: IqmPose;
}

export interface IqmMeshSpec {
  readonly name: string;
  readonly material: string;
  readonly firstVertex: number;
  readonly vertexCount: number;
  readonly firstTriangle: number;
  readonly triangleCount: number;
}

export interface IqmAnimSpec {
  readonly name: string;
  readonly firstFrame: number;
  readonly frameCount: number;
  readonly framerate: number;
  readonly loop: boolean;
}

export interface IqmSpec {
  readonly joints: readonly IqmJointSpec[];
  /** `frames[frame][joint]`. Empty for a model that has no frames. */
  readonly frames: readonly (readonly IqmPose[])[];
  readonly positions: readonly number[];
  readonly normals: readonly number[];
  readonly texcoords: readonly number[];
  readonly blendIndexes: readonly number[];
  readonly blendWeights: readonly number[];
  readonly triangles: readonly number[];
  readonly meshes: readonly IqmMeshSpec[];
  readonly anims: readonly IqmAnimSpec[];
  /** Per frame: minimum `x, y, z`, maximum `x, y, z`, radius around Z, radius around the origin. `null` writes none. */
  readonly bounds: readonly (readonly number[])[] | null;
  readonly blendIndexFormat: 'ubyte' | 'ushort';
  readonly blendWeightFormat: 'ubyte' | 'float';
}

/** The fields of the header after the magic, in file order, each a `uint32`. */
export const IQM_HEADER_FIELDS = [
  'version', 'filesize', 'flags',
  'num_text', 'ofs_text',
  'num_meshes', 'ofs_meshes',
  'num_vertexarrays', 'num_vertexes', 'ofs_vertexarrays',
  'num_triangles', 'ofs_triangles', 'ofs_adjacency',
  'num_joints', 'ofs_joints',
  'num_poses', 'ofs_poses',
  'num_anims', 'ofs_anims',
  'num_frames', 'num_framechannels', 'ofs_frames', 'ofs_bounds',
  'num_comment', 'ofs_comment',
  'num_extensions', 'ofs_extensions',
] as const;

export type IqmHeaderField = typeof IQM_HEADER_FIELDS[number];

const MAGIC = 'INTERQUAKEMODEL\0';

const VERTEX_ARRAY = { position: 0, texcoord: 1, normal: 2, blendIndexes: 4, blendWeights: 5 } as const;
const COMPONENT = { ubyte: 1, ushort: 3, float: 7 } as const;

/** Little-endian byte sink. */
class ByteSink {
  #bytes = new Uint8Array(1024);
  #view = new DataView(this.#bytes.buffer);
  position = 0;

  #reserve(size: number): void {
    if (this.position + size <= this.#bytes.length) {
      return;
    }

    const grown = new Uint8Array(Math.max(this.#bytes.length * 2, this.position + size));

    grown.set(this.#bytes);
    this.#bytes = grown;
    this.#view = new DataView(grown.buffer);
  }

  u8(value: number): void {
    this.#reserve(1);
    this.#view.setUint8(this.position, value);
    this.position += 1;
  }

  u16(value: number): void {
    this.#reserve(2);
    this.#view.setUint16(this.position, value, true);
    this.position += 2;
  }

  u32(value: number): void {
    this.#reserve(4);
    this.#view.setUint32(this.position, value, true);
    this.position += 4;
  }

  i32(value: number): void {
    this.#reserve(4);
    this.#view.setInt32(this.position, value, true);
    this.position += 4;
  }

  f32(value: number): void {
    this.#reserve(4);
    this.#view.setFloat32(this.position, value, true);
    this.position += 4;
  }

  text(value: string): void {
    for (const byte of new TextEncoder().encode(value)) {
      this.u8(byte);
    }
  }

  align4(): void {
    while (this.position % 4 !== 0) {
      this.u8(0);
    }
  }

  patchU32(at: number, value: number): void {
    this.#view.setUint32(at, value, true);
  }

  toArrayBuffer(): ArrayBuffer {
    return this.#bytes.slice(0, this.position).buffer;
  }
}

/** The text table: a leading zero (the empty string), then every string once. */
class StringTable {
  readonly bytes: number[] = [0];
  readonly #offsets = new Map<string, number>([['', 0]]);

  add(text: string): number {
    const known = this.#offsets.get(text);

    if (known !== undefined) {
      return known;
    }

    const offset = this.bytes.length;

    this.#offsets.set(text, offset);
    this.bytes.push(...new TextEncoder().encode(text), 0);

    return offset;
  }
}

/**
 * Reorders a pose from the engine's `w, x, y, z` to the file's channel order `x, y, z, w`.
 * @returns The ten channels in file order.
 */
function toFileChannels(pose: IqmPose): number[] {
  return [pose[0], pose[1], pose[2], pose[4], pose[5], pose[6], pose[3], pose[7], pose[8], pose[9]];
}

interface EncodedPoses {
  readonly masks: number[];
  readonly offsets: number[][];
  readonly scales: number[][];
  readonly values: number[];
}

/**
 * Quantizes every channel of every joint over all frames to `uint16` with an offset and scale, the way IQM
 * stores it. A channel that never changes is not stored: its mask bit stays clear and the offset carries it.
 * @returns Per joint the channel mask, offsets and scales, and the stored values frame by frame.
 */
function encodePoses(jointPoses: readonly IqmPose[], frames: readonly (readonly IqmPose[])[]): EncodedPoses {
  const jointCount = jointPoses.length;
  const masks: number[] = [];
  const offsets: number[][] = [];
  const scales: number[][] = [];
  const quantized: number[][][] = frames.map(() => Array.from({ length: jointCount }, () => [] as number[]));

  for (let joint = 0; joint < jointCount; joint++) {
    // A model without frames still has poses in the file, and they hold the bind pose.
    const channelsPerFrame = frames.length > 0 ? frames.map((frame) => toFileChannels(frame[joint])) : [toFileChannels(jointPoses[joint])];
    let mask = 0;
    const jointOffsets: number[] = [];
    const jointScales: number[] = [];

    for (let channel = 0; channel < 10; channel++) {
      const channelValues = channelsPerFrame.map((channels) => channels[channel]);
      const low = Math.min(...channelValues);
      const high = Math.max(...channelValues);
      const varies = high - low > 1e-6;
      const scale = varies ? (high - low) / 65535 : 0;

      jointOffsets.push(Math.fround(low));
      jointScales.push(Math.fround(scale));

      if (varies) {
        mask |= 1 << channel;
        channelValues.forEach((value, frame) => quantized[frame][joint].push(Math.round((value - Math.fround(low)) / Math.fround(scale))));
      }
    }

    masks.push(mask);
    offsets.push(jointOffsets);
    scales.push(jointScales);
  }

  return { masks, offsets, scales, values: quantized.flatMap((frame) => frame.flat()) };
}

/**
 * Writes an IQM v2 file.
 * @param spec The model.
 * @returns The file's bytes.
 */
export function buildIqm(spec: IqmSpec): ArrayBuffer {
  const out = new ByteSink();
  const strings = new StringTable();
  const meshNames = spec.meshes.map((mesh) => [strings.add(mesh.name), strings.add(mesh.material)]);
  const jointNames = spec.joints.map((joint) => strings.add(joint.name));
  const animNames = spec.anims.map((anim) => strings.add(anim.name));
  const poses = encodePoses(spec.joints.map((joint) => joint.pose), spec.frames);
  const vertexCount = spec.positions.length / 3;

  out.text(MAGIC);
  for (let index = 0; index < IQM_HEADER_FIELDS.length; index++) {
    out.u32(0);
  }

  const ofsText = out.position;
  strings.bytes.forEach((byte) => { out.u8(byte); });
  out.align4();

  const ofsMeshes = out.position;
  spec.meshes.forEach((mesh, index) => {
    [...meshNames[index], mesh.firstVertex, mesh.vertexCount, mesh.firstTriangle, mesh.triangleCount].forEach((value) => { out.u32(value); });
  });

  const arrays: { type: number; format: number; size: number; write: () => void }[] = [
    { type: VERTEX_ARRAY.position, format: COMPONENT.float, size: 3, write: () => { spec.positions.forEach((value) => { out.f32(value); }); } },
    { type: VERTEX_ARRAY.texcoord, format: COMPONENT.float, size: 2, write: () => { spec.texcoords.forEach((value) => { out.f32(value); }); } },
    { type: VERTEX_ARRAY.normal, format: COMPONENT.float, size: 3, write: () => { spec.normals.forEach((value) => { out.f32(value); }); } },
    {
      type: VERTEX_ARRAY.blendIndexes,
      format: COMPONENT[spec.blendIndexFormat],
      size: 4,
      write: () => { spec.blendIndexes.forEach((value) => { spec.blendIndexFormat === 'ubyte' ? out.u8(value) : out.u16(value); }); },
    },
    {
      type: VERTEX_ARRAY.blendWeights,
      format: COMPONENT[spec.blendWeightFormat],
      size: 4,
      write: () => { spec.blendWeights.forEach((value) => { spec.blendWeightFormat === 'ubyte' ? out.u8(Math.round(value * 255)) : out.f32(value); }); },
    },
  ];

  const ofsVertexArrays = out.position;
  const arrayRecords = out.position;
  out.position += arrays.length * 20;
  const arrayOffsets: number[] = [];

  for (const array of arrays) {
    out.align4();
    arrayOffsets.push(out.position);
    array.write();
  }

  out.align4();

  const ofsTriangles = out.position;
  spec.triangles.forEach((value) => { out.u32(value); });

  const ofsJoints = out.position;
  spec.joints.forEach((joint, index) => {
    out.u32(jointNames[index]);
    out.i32(joint.parent);
    toFileChannels(joint.pose).forEach((value) => { out.f32(value); });
  });

  const ofsPoses = out.position;
  spec.joints.forEach((joint, index) => {
    out.i32(joint.parent);
    out.u32(poses.masks[index]);
    poses.offsets[index].forEach((value) => { out.f32(value); });
    poses.scales[index].forEach((value) => { out.f32(value); });
  });

  const ofsAnims = out.position;
  spec.anims.forEach((anim, index) => {
    out.u32(animNames[index]);
    out.u32(anim.firstFrame);
    out.u32(anim.frameCount);
    out.f32(anim.framerate);
    out.u32(anim.loop ? 1 : 0);
  });

  const ofsFrames = out.position;
  poses.values.forEach((value) => { out.u16(value); });
  out.align4();

  const ofsBounds = spec.bounds === null ? 0 : out.position;
  spec.bounds?.forEach((frame) => { frame.forEach((value) => { out.f32(value); }); });

  // The vertex array records are written last because they need the offsets of the data.
  const end = out.position;

  out.position = arrayRecords;
  arrays.forEach((array, index) => {
    [array.type, 0, array.format, array.size, arrayOffsets[index]].forEach((value) => { out.u32(value); });
  });
  out.position = end;

  const fields: Record<IqmHeaderField, number> = {
    version: 2,
    filesize: end,
    flags: 0,
    num_text: strings.bytes.length,
    ofs_text: ofsText,
    num_meshes: spec.meshes.length,
    ofs_meshes: ofsMeshes,
    num_vertexarrays: arrays.length,
    num_vertexes: vertexCount,
    ofs_vertexarrays: ofsVertexArrays,
    num_triangles: spec.triangles.length / 3,
    ofs_triangles: ofsTriangles,
    ofs_adjacency: 0,
    num_joints: spec.joints.length,
    ofs_joints: ofsJoints,
    num_poses: spec.joints.length,
    ofs_poses: ofsPoses,
    num_anims: spec.anims.length,
    ofs_anims: ofsAnims,
    num_frames: spec.frames.length,
    num_framechannels: poses.masks.reduce((sum, mask) => sum + mask.toString(2).replace(/0/g, '').length, 0),
    ofs_frames: ofsFrames,
    ofs_bounds: ofsBounds,
    num_comment: 0,
    ofs_comment: 0,
    num_extensions: 0,
    ofs_extensions: 0,
  };

  IQM_HEADER_FIELDS.forEach((field, index) => { out.patchU32(MAGIC.length + index * 4, fields[field]); });

  return out.toArrayBuffer();
}

/**
 * Copies a file with one header field replaced.
 * @param buffer The file.
 * @param field Which field.
 * @param value The new value.
 * @returns The damaged copy.
 */
export function patchHeader(buffer: ArrayBuffer, field: IqmHeaderField, value: number): ArrayBuffer {
  const copy = buffer.slice(0);

  new DataView(copy).setUint32(MAGIC.length + IQM_HEADER_FIELDS.indexOf(field) * 4, value, true);

  return copy;
}

/** A pose with no translation, no rotation and no scale. */
export const IDENTITY_POSE: IqmPose = [0, 0, 0, 1, 0, 0, 0, 1, 1, 1];

const SQRT_HALF = Math.SQRT1_2;

/**
 * A model of two joints, `root` at the origin and `child` 10 units along X below it, three vertices, one triangle,
 * two frames (the second turns `child` by 90 degrees around Z) and the bounds of both frames worked out by hand:
 *
 * - frame 0 (rest): vertices (10, 1, 0), (0, 1, 0), (5, 0, 0): minimum (0, 0, 0), maximum (10, 1, 0), radius around Z
 *   and around the origin `hypot(10, 1)`.
 * - frame 1: the vertex on `child` moves to (9, 0, 0) and the one shared half-and-half to (7.5, -2.5, 0): minimum
 *   (0, -2.5, 0), maximum (9, 1, 0), both radii 9.
 * @param overrides Parts of the model to replace.
 * @returns The description of the model.
 */
export function createTwoJointSpec(overrides: Partial<IqmSpec> = {}): IqmSpec {
  const root = IDENTITY_POSE;
  const child: IqmPose = [10, 0, 0, 1, 0, 0, 0, 1, 1, 1];
  const turned: IqmPose = [10, 0, 0, SQRT_HALF, 0, 0, SQRT_HALF, 1, 1, 1];

  return {
    joints: [{ name: 'root', parent: -1, pose: root }, { name: 'child', parent: 0, pose: child }],
    frames: [[root, child], [root, turned]],
    positions: [10, 1, 0, 0, 1, 0, 5, 0, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
    texcoords: [0, 0, 1, 0, 0, 1],
    blendIndexes: [1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0],
    blendWeights: [1, 0, 0, 0, 1, 0, 0, 0, 0.5, 0.5, 0, 0],
    triangles: [0, 1, 2],
    meshes: [{ name: 'body', material: 'progs/body', firstVertex: 0, vertexCount: 3, firstTriangle: 0, triangleCount: 1 }],
    anims: [{ name: 'turn', firstFrame: 0, frameCount: 2, framerate: 10, loop: true }],
    bounds: [
      [0, 0, 0, 10, 1, 0, Math.hypot(10, 1), Math.hypot(10, 1)],
      [0, -2.5, 0, 9, 1, 0, 9, 9],
    ],
    blendIndexFormat: 'ubyte',
    blendWeightFormat: 'ubyte',
    ...overrides,
  };
}
