import type { BaseMaterial } from '../../client/renderer/models/Materials.ts';

import Vector from '../../../shared/Vector.ts';
import { BaseModel } from './BaseModel.ts';
import { ModelType } from '../Mod.ts';

/**
 * Mesh model, a generic static polygon mesh format for OBJ and similar assets, with modern vertex attributes.
 * Posed, skinned models are `SkeletalModel`s.
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

  constructor(name: string) {
    super(name);
    this.type = ModelType.mesh;
  }

  override createScopedView(): this {
    const scopedView = super.createScopedView() as this;

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
