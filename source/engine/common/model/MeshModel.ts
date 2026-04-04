import type { BaseMaterial } from '../../client/renderer/Materials.ts';

import Vector from '../../../shared/Vector.ts';
import { BaseModel } from './BaseModel.ts';

interface MeshAnimation {
  readonly name?: string;
  readonly firstFrame?: number;
  readonly frameCount?: number;
  readonly fps?: number;
}

interface MeshBone {
  readonly name?: string;
  readonly parentIndex?: number;
}

interface MeshSubmesh {
  readonly startIndex?: number;
  readonly indexCount?: number;
  readonly materialName?: string;
}

/**
 * Mesh model, a generic polygon mesh format for OBJ, IQM, glTF, and similar assets.
 * Used for static and animated meshes with modern vertex attributes.
 */
export class MeshModel extends BaseModel {
  /** Position buffer stored as flat `x, y, z` triplets. */
  vertices: Float32Array | null = null;

  /** Normal buffer stored as flat `x, y, z` triplets. */
  normals: Float32Array | null = null;

  /** Texture coordinate buffer stored as flat `u, v` pairs. */
  texcoords: Float32Array | null = null;

  /** Tangent buffer used for normal mapping. */
  tangents: Float32Array | null = null;

  /** Bitangent buffer used for normal mapping. */
  bitangents: Float32Array | null = null;

  /** Triangle index buffer. */
  indices: Uint16Array | Uint32Array | null = null;

  /** Number of vertices in the mesh. */
  numVertices = 0;

  /** Number of triangles in the mesh. */
  numTriangles = 0;

  /** Material library reference. */
  materialName = '';

  /** Diffuse texture path or asset name. */
  textureName = '';

  /** Loaded material instance used by the renderer. */
  texture: BaseMaterial | null = null;

  /** Vertex buffer object created by the renderer. */
  vbo: WebGLBuffer | null = null;

  /** Index buffer object created by the renderer. */
  ibo: WebGLBuffer | null = null;

  /** Vertex array object created by the renderer. */
  vao: WebGLVertexArrayObject | null = null;

  /** Conservative bounding box minimum. */
  override mins = new Vector(-16, -16, -16);

  /** Conservative bounding box maximum. */
  override maxs = new Vector(16, 16, 16);

  /** Bounding sphere radius. */
  boundingradius = 16.0;

  /** True when the mesh carries skeletal or keyframed animation data. */
  animated = false;

  /** Animation clips for future IQM or glTF support. */
  animations: MeshAnimation[] = [];

  /** Skeleton or bind-pose bone metadata. */
  bones: MeshBone[] = [];

  /** Optional submesh partitions for multi-material meshes. */
  submeshes: MeshSubmesh[] = [];

  constructor(name: string) {
    super(name);
    this.type = 3;
  }

  override createScopedView(): MeshModel {
    const scopedView = super.createScopedView() as MeshModel;

    // Scoped views must not own shared GPU objects from the source model.
    scopedView.vbo = null;
    scopedView.ibo = null;
    scopedView.vao = null;

    return scopedView;
  }

  override cleanupScopedView(): void {
    super.cleanupScopedView();

    const gl = this._getGLContext();

    if (gl === null) {
      return;
    }

    if (this.vao !== null) {
      gl.deleteVertexArray(this.vao);
      this.vao = null;
    }

    if (this.vbo !== null) {
      gl.deleteBuffer(this.vbo);
      this.vbo = null;
    }

    if (this.ibo !== null) {
      gl.deleteBuffer(this.ibo);
      this.ibo = null;
    }
  }
}
