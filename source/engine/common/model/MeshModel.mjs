import { BaseMaterial } from '../../client/renderer/Materials.mjs';
import Vector from '../../../shared/Vector.ts';
import { BaseModel } from './BaseModel.mjs';

/**
 * Mesh model - Generic polygon mesh format for OBJ, IQM, GLTF, etc.
 * Used for static and animated meshes with modern vertex attributes.
 */
export class MeshModel extends BaseModel {
  constructor(name) {
    super(name);
    this.type = 3; // Mod.type.mesh
  }

  // Vertex data (flat arrays ready for WebGL)
  /** @type {Float32Array|null} */ vertices = null;      // Positions (x,y,z triplets)
  /** @type {Float32Array|null} */ normals = null;       // Normals (x,y,z triplets)
  /** @type {Float32Array|null} */ texcoords = null;     // UVs (u,v pairs)
  /** @type {Float32Array|null} */ tangents = null;      // Tangents for normal mapping (x,y,z triplets)
  /** @type {Float32Array|null} */ bitangents = null;    // Bitangents for normal mapping (x,y,z triplets)

  // Geometry
  /** @type {Uint16Array|Uint32Array|null} */ indices = null;  // Triangle indices
  /** @type {number} */ numVertices = 0;
  /** @type {number} */ numTriangles = 0;

  // Materials & textures
  /** @type {string} */ materialName = '';     // Material library reference
  /** @type {string} */ textureName = '';      // Diffuse texture path
  /** @type {BaseMaterial|null} */ texture = null;   // Loaded texture object

  // GPU buffers (created by renderer)
  /** @type {WebGLBuffer|null} */ vbo = null;  // Vertex buffer object
  /** @type {WebGLBuffer|null} */ ibo = null;  // Index buffer object

  // Bounding volume
  /** @type {Vector} */ mins = new Vector(-16, -16, -16);
  /** @type {Vector} */ maxs = new Vector(16, 16, 16);
  /** @type {number} */ boundingradius = 16.0;

  // Animation support (for future IQM/GLTF)
  /** @type {boolean} */ animated = false;
  /** @type {Array} */ animations = [];
  /** @type {Array} */ bones = [];

  // Submesh support (multiple materials)
  /** @type {Array} */ submeshes = [];

  /**
   * @returns {MeshModel} scoped runtime view
   */
  createScopedView() {
    const scopedView = /** @type {MeshModel} */ (super.createScopedView());

    scopedView.vbo = null;
    scopedView.ibo = null;
    scopedView.vao = null;

    return scopedView;
  }

  cleanupScopedView() {
    super.cleanupScopedView();

    const gl = this._getGLContext();

    if (gl === null) {
      return;
    }

    if (this.vao) {
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
