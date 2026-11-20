import type { GLTexture } from '../../client/GL.ts';
import { BaseModel } from './BaseModel.ts';
import { SkeletalAnimation } from './SkeletalAnimation.ts';
import { ModelType } from './ModelType.ts';
import type { JointAdjustments } from './JointAdjustments.ts';

/** A named run of frames, played by the sequence state of an entity. */
export interface SkeletalSequence {
  readonly name: string;
  readonly firstFrame: number;
  readonly frameCount: number;
  /** Frames per second at a playback rate of 1. Zero for a sequence that holds one pose. */
  readonly framerate: number;
  readonly loop: boolean;
}

/**
 * A material of the model: its name from the file and the textures `SkeletalMaterialLoader` found for it, which
 * stay `null` in a realm that does not draw, and for a layer that has no file.
 */
export interface SkeletalMaterial {
  readonly name: string;
  /** The base color. `null` when no file exists: the renderer draws its checkerboard. */
  diffuse: GLTexture | null;
  /** Glow, added to the lit color and fed to the bloom pass (`<material>_glow`). */
  glow: GLTexture | null;
  /** Greyscale mask of the parts the shirt color is added to (`<material>_shirt`). */
  shirt: GLTexture | null;
  /** Greyscale mask of the parts the pants color is added to (`<material>_pants`). */
  pants: GLTexture | null;
}

/** A run of vertices and triangles of one material, indexes into the arrays of `SkeletalMeshData`. */
export interface SkeletalMeshRange {
  readonly name: string;
  /** Index into `SkeletalModel.materials`. */
  readonly materialIndex: number;
  readonly firstVertex: number;
  readonly vertexCount: number;
  readonly firstTriangle: number;
  readonly triangleCount: number;
}

/**
 * The skinned mesh in its bind pose. A realm without a renderer does not keep it.
 */
export interface SkeletalMeshData {
  /** Bind pose positions, `x, y, z` per vertex. */
  readonly positions: Float32Array;
  /** Bind pose normals, `x, y, z` per vertex. */
  readonly normals: Float32Array;
  /** Texture coordinates, `s, t` per vertex, `t` running down the image. */
  readonly texcoords: Float32Array;
  /** Four joint indexes per vertex. */
  readonly blendIndexes: Uint16Array;
  /** Four weights per vertex, summing to one. */
  readonly blendWeights: Float32Array;
  /** Three vertex indexes per triangle, counter-clockwise seen from the front. */
  readonly triangles: Uint32Array;
}

/**
 * Base class of models that are posed by a joint hierarchy and skinned on the CPU, whatever file format
 * they come from. A subclass per format fills it in; it holds nothing that belongs to one format.
 *
 * Everything is stored in flat typed arrays (per-vertex objects cost about 22 times as much memory, see
 * `plans/server-model-memory.md`) and is immutable once the loader is done, so `createScopedView()` shares it.
 *
 * Rotations are quaternions in the engine-wide layout `w, x, y, z`. A pose is `POSE_FLOATS` numbers per
 * joint: translation `x, y, z`, rotation `w, x, y, z`, scale `x, y, z`, in the space of the parent joint.
 * The matrix of a joint is translation times rotation times scale (scale first), composed parent before child.
 */
export abstract class SkeletalModel extends BaseModel {
  /** Numbers per joint in `restPose` and `framePoses`. */
  static readonly POSE_FLOATS = 10;

  /** Numbers per frame in `frameBounds`: minimum `x, y, z`, maximum `x, y, z`, radius around the Z axis, radius around the origin. */
  static readonly BOUNDS_FLOATS = 8;

  /** Joint names. Every joint can be a tag. */
  jointNames: string[] = [];

  /** Index of the parent of each joint, `-1` for a root. A parent always has a lower index than its children. */
  jointParents: Int32Array = new Int32Array(0);

  /** The bind pose, one pose per joint. */
  restPose: Float32Array = new Float32Array(0);

  /**
   * The inverse of every joint's bind pose matrix, `jointCount * SkeletalAnimation.MATRIX_FLOATS` numbers (3×4,
   * row major), computed once by the loader. A joint matrix times this moves a bind pose vertex to its posed place.
   */
  inverseBindMatrices: Float32Array = new Float32Array(0);

  /** Every frame's pose of every joint: `frameCount * jointCount * POSE_FLOATS` numbers, frame major. */
  framePoses: Float32Array = new Float32Array(0);

  /** Bounds of every frame, `frameCount * BOUNDS_FLOATS` numbers, in model space. */
  frameBounds: Float32Array = new Float32Array(0);

  /** Radius of the bounding sphere around the origin over all frames. */
  boundingradius = 0;

  /** Named runs of frames. Empty for a model that is only driven by frame number. */
  sequences: SkeletalSequence[] = [];

  /** Materials, in the order meshes first use them. Empty in a realm without a renderer. */
  materials: SkeletalMaterial[] = [];

  /** The meshes of the model. Empty in a realm without a renderer. */
  meshes: SkeletalMeshRange[] = [];

  /** The skinned mesh. `null` in a realm without a renderer. */
  meshData: SkeletalMeshData | null = null;

  constructor(name: string) {
    super(name);
    this.type = ModelType.skeletal;
  }

  /**
   * Human-readable name of the file format this model was loaded from.
   * @returns The format name, for example for `modelinfo`.
   */
  abstract get formatName(): string;

  /**
   * Number of joints.
   * @returns The joint count.
   */
  get jointCount(): number {
    return this.jointNames.length;
  }

  /**
   * Every joint is a tag, named like the joint: a rig names the bones of a hand or a gun, the exporter renames them to what a
   * game looks up (`tag_weapon`, `tag_flash`).
   * @param name The joint's name.
   * @returns The joint's index, -1 when there is none of that name.
   */
  override getTagIndex(name: string): number {
    return name === '' ? -1 : this.jointNames.indexOf(name);
  }

  /**
   * The joint as a rigid transform in model space, which is the same place `SkeletalAnimation.computePose` puts it (see
   * `SkeletalAnimation.sampleJointInto`). The server realm has the joints and frames too, so it answers the same.
   * @returns `false` for an index that is no joint.
   */
  override sampleTag(
    index: number,
    frameA: number,
    frameB: number,
    blend: number,
    out: Float32Array | Float64Array | number[],
    adjustments: JointAdjustments | null = null,
  ): boolean {
    return SkeletalAnimation.sampleJointInto(this, index, frameA, frameB, blend, out, adjustments);
  }

  /**
   * Finds a named sequence of the file.
   * @param name The name from the file's animation list.
   * @returns The entity's `sequence` that selects it, -1 when there is none of that name.
   */
  override sequenceIndex(name: string): number {
    return name === '' ? -1 : this.sequences.findIndex((sequence) => sequence.name === name);
  }

  /**
   * How long a sequence plays: every frame is shown for one period of the sequence's frame rate, so the last one has
   * been on screen for its time when the sequence is over.
   * @param sequence The entity's `sequence`.
   * @returns Seconds, `Infinity` for a sequence that loops, 0 for one that holds a single pose (a frame rate of 0 or a
   * single frame) and for a number that selects none.
   */
  override sequenceDuration(sequence: number): number {
    const entry = this.sequences[sequence];

    if (entry === undefined || entry.frameCount < 2 || entry.framerate <= 0) {
      return 0;
    }

    return entry.loop ? Infinity : entry.frameCount / entry.framerate;
  }

  /**
   * Number of frames. A model without frames of its own has one: its rest pose.
   * @returns The frame count.
   */
  get frameCount(): number {
    return this._num_frames;
  }
}
