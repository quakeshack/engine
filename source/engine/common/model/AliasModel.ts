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

interface AliasSingleFrame {
  readonly group: false;
  readonly bboxmin: Vector;
  readonly bboxmax: Vector;
  readonly name: string;
  readonly v: AliasPoseVertex[];
  readonly cmdofs?: number;
}

interface AliasGroupedFrameEntry {
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

interface AliasSingleSkin {
  readonly group: false;
  readonly texturenum: GLTexture | null;
  readonly luminanceTexture: GLTexture | null;
  readonly translated?: Uint8Array;
  readonly playertexture?: GLTexture | null;
}

interface AliasGroupedSkinEntry {
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
export type AliasSkin = AliasSingleSkin | AliasGroupedSkin;

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
}
