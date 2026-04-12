import type { GLTexture } from '../../client/GL.ts';

import Vector from '../../../shared/Vector.ts';
import { BaseModel } from './BaseModel.ts';

interface AliasStVertex {
  readonly onseam: boolean;
  readonly s: number;
  readonly t: number;
}

interface AliasTriangle {
  readonly facesfront: boolean;
  readonly vertindex: number[];
}

interface AliasPoseVertex {
  readonly v: Vector;
  readonly lightnormalindex: number;
}

export interface AliasSingleFrame {
  readonly group: false;
  readonly bboxmin: Vector;
  readonly bboxmax: Vector;
  readonly name: string;
  readonly v: AliasPoseVertex[];
  readonly cmdofs?: number;
}

export interface AliasGroupedFrameEntry {
  readonly interval: number;
  readonly bboxmin: Vector;
  readonly bboxmax: Vector;
  readonly name: string;
  readonly v: AliasPoseVertex[];
  readonly cmdofs?: number;
}

interface AliasGroupedFrame {
  readonly group: true;
  readonly bboxmin: Vector;
  readonly bboxmax: Vector;
  readonly frames: AliasGroupedFrameEntry[];
}

export interface AliasSingleSkin {
  readonly group: false;
  readonly texturenum: GLTexture | null;
  readonly luminanceTexture: GLTexture | null;
  readonly translated?: Uint8Array;
  readonly playertexture?: GLTexture | null;
}

export interface AliasGroupedSkinEntry {
  readonly interval: number;
  readonly texturenum?: GLTexture | null;
  readonly luminanceTexture?: GLTexture | null;
  readonly translated?: Uint8Array;
  readonly playertexture?: GLTexture | null;
}

interface AliasGroupedSkin {
  readonly group: true;
  readonly skins: AliasGroupedSkinEntry[];
}

export type AliasFrame = AliasSingleFrame | AliasGroupedFrame;
export type AliasCollisionFrame = AliasSingleFrame | AliasGroupedFrameEntry;
export type AliasSkin = AliasSingleSkin | AliasGroupedSkin;

/**
 * Resolve the active frame inside a grouped alias animation.
 * @returns The active grouped frame entry, or `null` when the group is empty.
 */
function selectGroupedCollisionFrame(group: AliasGroupedFrame, time: number): AliasGroupedFrameEntry | null {
  const frameCount = group.frames.length;

  if (frameCount === 0) {
    return null;
  }

  const fullInterval = group.frames[frameCount - 1]?.interval ?? 0.0;

  if (fullInterval <= 0.0) {
    return group.frames[0] ?? null;
  }

  const targetTime = time - Math.floor(time / fullInterval) * fullInterval;

  for (const frame of group.frames) {
    if (frame.interval > targetTime) {
      return frame;
    }
  }

  return group.frames[frameCount - 1] ?? null;
}

/**
 * Transform raw alias-frame bounds into scaled model-space bounds.
 * @returns The transformed minimum and maximum bounds.
 */
function transformAliasBounds(
  rawMins: Vector,
  rawMaxs: Vector,
  scale: Vector,
  scaleOrigin: Vector,
): { mins: Vector; maxs: Vector } {
  const minX = rawMins[0] * scale[0] + scaleOrigin[0];
  const maxX = rawMaxs[0] * scale[0] + scaleOrigin[0];
  const minY = rawMins[1] * scale[1] + scaleOrigin[1];
  const maxY = rawMaxs[1] * scale[1] + scaleOrigin[1];
  const minZ = rawMins[2] * scale[2] + scaleOrigin[2];
  const maxZ = rawMaxs[2] * scale[2] + scaleOrigin[2];

  return {
    mins: new Vector(
      Math.min(minX, maxX),
      Math.min(minY, maxY),
      Math.min(minZ, maxZ),
    ),
    maxs: new Vector(
      Math.max(minX, maxX),
      Math.max(minY, maxY),
      Math.max(minZ, maxZ),
    ),
  };
}

/**
 * Alias model (.mdl), Quake's animated triangle mesh format.
 * Used for characters, monsters, weapons, and other animated models.
 */
export class AliasModel extends BaseModel {
  /** Scale factors for vertices. */
  override _scale: Vector | null = null;

  /** Origin offset for vertices. */
  override _scale_origin: Vector | null = null;

  /** Number of skins in file. */
  override _num_skins = 0;

  /** Skin texture width. */
  _skin_width = 0;

  /** Skin texture height. */
  _skin_height = 0;

  /** Number of vertices. */
  override _num_verts = 0;

  /** Number of triangles. */
  override _num_tris = 0;

  /** Number of frames in file. */
  _frames = 0;

  /** Triangle definitions. */
  _triangles: AliasTriangle[] = [];

  /** Texture coordinate vertices. */
  _stverts: AliasStVertex[] = [];

  /** Animation frames used by rendering and host-side metadata lookups. */
  frames: AliasFrame[] = [];

  /** Skin textures used by the renderer. */
  skins: AliasSkin[] = [];

  /** Bounding radius consumed by the renderer. */
  boundingradius = 0;

  /** True when this is a player model that supports color translation. */
  player = false;

  constructor(name: string) {
    super(name);
    this.type = 2;
  }

  override reset(): void {
    super.reset();
    this._scale = null;
    this._scale_origin = null;
    this._num_skins = 0;
    this._skin_width = 0;
    this._skin_height = 0;
    this._num_verts = 0;
    this._num_tris = 0;
    this._frames = 0;
    this._triangles = [];
    this._stverts = [];
    this.frames = [];
    this.skins = [];
    this.boundingradius = 0;
    this.player = false;
  }

  /**
   * Resolve the active collision pose for a model frame at a given time.
   * @returns The resolved collision pose, or `null` when the frame index is invalid.
   */
  resolveCollisionFrame(frameIndex: number, time: number): AliasCollisionFrame | null {
    const frame = this.frames[frameIndex];

    if (frame === undefined) {
      return null;
    }

    if (!frame.group) {
      return frame;
    }

    return selectGroupedCollisionFrame(frame, time);
  }

  /**
   * Return the number of collision triangles carried by the model.
   * @returns The number of collision triangles.
   */
  getCollisionTriangleCount(): number {
    return this._triangles.length;
  }

  /**
   * Return the vertex indices for a collision triangle.
   * @returns The triangle's vertex indices, or `null` when the triangle does not exist.
   */
  getCollisionTriangleVertexIndices(triangleIndex: number): readonly [number, number, number] | null {
    const triangle = this._triangles[triangleIndex];

    if (triangle === undefined) {
      return null;
    }

    const [index0, index1, index2] = triangle.vertindex;

    if (index0 === undefined || index1 === undefined || index2 === undefined) {
      return null;
    }

    return [index0, index1, index2];
  }

  /**
   * Return a scaled model-space collision vertex from a resolved pose.
   * @returns The scaled model-space collision vertex, or `null` when unavailable.
   */
  getCollisionVertex(frame: AliasCollisionFrame, vertexIndex: number): Vector | null {
    const scale = this._scale;
    const scaleOrigin = this._scale_origin;

    if (scale === null || scaleOrigin === null) {
      return null;
    }

    const poseVertex = frame.v[vertexIndex];

    if (poseVertex === undefined) {
      return null;
    }

    return new Vector(
      poseVertex.v[0] * scale[0] + scaleOrigin[0],
      poseVertex.v[1] * scale[1] + scaleOrigin[1],
      poseVertex.v[2] * scale[2] + scaleOrigin[2],
    );
  }

  /**
   * Compute conservative collision bounds that cover every stored pose.
   * @returns Bounds that cover every stored pose, or `null` when they cannot be derived.
   */
  getCollisionBounds(): { mins: Vector; maxs: Vector } | null {
    const scale = this._scale;
    const scaleOrigin = this._scale_origin;

    if (scale === null || scaleOrigin === null || this.frames.length === 0) {
      return null;
    }

    const mins = new Vector(Infinity, Infinity, Infinity);
    const maxs = new Vector(-Infinity, -Infinity, -Infinity);

    const mergeBounds = (frame: AliasCollisionFrame): void => {
      const transformed = transformAliasBounds(frame.bboxmin, frame.bboxmax, scale, scaleOrigin);

      mins[0] = Math.min(mins[0], transformed.mins[0]);
      mins[1] = Math.min(mins[1], transformed.mins[1]);
      mins[2] = Math.min(mins[2], transformed.mins[2]);
      maxs[0] = Math.max(maxs[0], transformed.maxs[0]);
      maxs[1] = Math.max(maxs[1], transformed.maxs[1]);
      maxs[2] = Math.max(maxs[2], transformed.maxs[2]);
    };

    for (const frame of this.frames) {
      if (frame.group) {
        for (const groupedFrame of frame.frames) {
          mergeBounds(groupedFrame);
        }
        continue;
      }

      mergeBounds(frame);
    }

    if (!Number.isFinite(mins[0]) || !Number.isFinite(maxs[0])) {
      return null;
    }

    return { mins, maxs };
  }
}
