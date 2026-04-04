import Vector from '../../../shared/Vector.ts';
import { ModelRenderer } from './ModelRenderer.mjs';
import { getEntityBloomEmissiveScale } from './BloomEffect.mjs';
import { eventBus, registry } from '../../registry.mjs';
import GL, { ATTRIB_LOCATIONS } from '../GL.mjs';

let { Con, R } = registry;

eventBus.subscribe('registry.frozen', () => {
  ({ Con, R } = registry);
});

let gl = /** @type {WebGL2RenderingContext} */ (null);

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null;
});

/**
 * Renderer for Mesh models (OBJ, IQM, GLTF, etc.).
 * Handles static mesh rendering with modern vertex attributes.
 */
export class MeshModelRenderer extends ModelRenderer {
  /**
   * Get the model type this renderer handles
   * @returns {number} Mod.type.mesh (3)
   */
  getModelType() {
    return 3; // Mod.type.mesh
  }

  /**
   * Setup rendering state for mesh models.
   * @param {number} [_pass] Rendering pass (0=opaque, 1=transparent)
   */
  // eslint-disable-next-line no-unused-vars
  setupRenderState(_pass = 0) {
    // Mesh models bind their own buffers and state per-entity
    // No shared setup needed at this level
  }

  /**
   * @param {import('../../common/model/MeshModel.ts').MeshModel} _model The mesh model
   * @param {import('../ClientEntities.ts').ClientEdict} _entity The entity being rendered
   * @returns {boolean} Mesh transparency is not implemented, so meshes stay in the opaque pass
   */
  // eslint-disable-next-line no-unused-vars
  rendersOpaquePass(_model, _entity) {
    return true;
  }

  /**
   * @param {import('../../common/model/MeshModel.ts').MeshModel} _model The mesh model
   * @param {import('../ClientEntities.ts').ClientEdict} _entity The entity being rendered
   * @returns {boolean} False because sorted transparent mesh rendering is not implemented yet
   */
  // eslint-disable-next-line no-unused-vars
  rendersTransparentPass(_model, _entity) {
    return false;
  }

  /**
   * Cleanup rendering state after rendering mesh models.
   * @param {number} [_pass] Rendering pass (0=opaque, 1=transparent)
   */
  // eslint-disable-next-line no-unused-vars
  cleanupRenderState(_pass = 0) {
    // No shared cleanup needed
  }

  /**
   * Render a single mesh model entity.
   * @param {import('../../common/model/MeshModel.ts').MeshModel} model The mesh model to render
   * @param {import('../ClientEntities.ts').ClientEdict} entity The entity being rendered
   * @param {number} pass Rendering pass (0=opaque, 1=transparent)
   */
  render(model, entity, pass = 0) {
    const clmodel = model;
    const e = entity;

    // Only render in opaque pass for now
    if (pass !== 0) {
      return;
    }

    // Frustum culling
    if (R.CullBox(
      new Vector(
        e.origin[0] + clmodel.mins[0],
        e.origin[1] + clmodel.mins[1],
        e.origin[2] + clmodel.mins[2],
      ),
      new Vector(
        e.origin[0] + clmodel.maxs[0],
        e.origin[1] + clmodel.maxs[1],
        e.origin[2] + clmodel.maxs[2],
      )) === true) {
      return;
    }

    // Ensure VBO/IBO are created
    if (!clmodel.vbo) {
      return; // Not prepared yet
    }

    // Use dedicated mesh shader
    const program = GL.UseProgram('mesh');

    // Bind model VAO (captures VBO layout + IBO)
    GL.BindVAO(clmodel.vao);

    // Setup uniforms
    const viewMatrix = e.lerp.angles.toRotationMatrix();
    gl.uniform3fv(program.uOrigin, e.lerp.origin);
    gl.uniformMatrix3fv(program.uAngles, false, viewMatrix);

    // Lighting
    const [ambientlight, shadelight, lightPosition, dynamicShadeLight, dynamicLightPosition] = R._CalculateLightValues(e);
    gl.uniform3fv(program.uAmbientLight, ambientlight);
    gl.uniform3fv(program.uShadeLight, shadelight);
    gl.uniform3fv(program.uLightVec, lightPosition);
    gl.uniform3fv(program.uDynamicShadeLight, dynamicShadeLight);
    gl.uniform3fv(program.uDynamicLightVec, dynamicLightPosition);
    gl.uniform1f(program.uBloomEmissiveScale, getEntityBloomEmissiveScale(e.effects));

    // Bind texture
    if (clmodel.texture) {
      clmodel.texture.bindTo(program);
    } else {
      R.notexture.bind(program.tTexture);
    }

    // Bind local shadow maps
    if (program.tShadowMap0 !== undefined && R.shadow_textures?.[0]) {
      GL.Bind(program.tShadowMap0, R.shadow_textures[0]);
    }
    if (program.tShadowMap1 !== undefined && R.shadow_textures?.[1]) {
      GL.Bind(program.tShadowMap1, R.shadow_textures[1]);
    }
    if (program.tShadowMap2 !== undefined && R.shadow_textures?.[2]) {
      GL.Bind(program.tShadowMap2, R.shadow_textures[2]);
    }

    // Bind point light cube shadow map
    if (program.tPointShadowMap !== undefined && R.point_shadow_texture) {
      GL.BindCube(program.tPointShadowMap, R.point_shadow_texture);
    }

    // Draw (IBO is captured in the VAO)
    const indexType = clmodel.indices instanceof Uint16Array ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT;
    gl.drawElements(gl.TRIANGLES, clmodel.numTriangles * 3, indexType, 0);
    GL.UnbindVAO();

    // Stats
    R.c_alias_draws++;
    R.c_alias_verts += clmodel.numVertices;
    R.c_alias_tris += clmodel.numTriangles;
  }

  /**
   * Prepare mesh model for rendering (build display lists, upload to GPU).
   * @param {import('../../common/model/MeshModel.ts').MeshModel} model The mesh model to prepare
   * @param {boolean} isWorldModel Whether this model is the world model
   */
  // eslint-disable-next-line no-unused-vars
  prepareModel(model, isWorldModel = false) {
    const m = model;

    // Clean up existing buffers if present
    if (m.vbo) {
      gl.deleteBuffer(m.vbo);
      m.vbo = null;
    }
    if (m.ibo) {
      gl.deleteBuffer(m.ibo);
      m.ibo = null;
    }
    if (m.vao) {
      gl.deleteVertexArray(m.vao);
      m.vao = null;
    }

    if (!m.vertices || m.vertices.length === 0) {
      Con.DPrint(`MeshModelRenderer.prepareModel: ${m.name} has no vertices!\n`);
      return;
    }

    // Build interleaved vertex buffer
    // Format: Position(3) + TexCoord(2) + Normal(3) + Tangent(3) + Bitangent(3) = 14 floats per vertex
    const numVerts = m.numVertices;
    const vertexData = new Float32Array(numVerts * 14);

    for (let i = 0; i < numVerts; i++) {
      const offset = i * 14;

      // Position
      vertexData[offset + 0] = m.vertices[i * 3];
      vertexData[offset + 1] = m.vertices[i * 3 + 1];
      vertexData[offset + 2] = m.vertices[i * 3 + 2];

      // TexCoord
      if (m.texcoords) {
        vertexData[offset + 3] = m.texcoords[i * 2];
        vertexData[offset + 4] = 1.0 - m.texcoords[i * 2 + 1];
      } else {
        vertexData[offset + 3] = 0;
        vertexData[offset + 4] = 0;
      }

      // Normal
      if (m.normals) {
        vertexData[offset + 5] = m.normals[i * 3];
        vertexData[offset + 6] = m.normals[i * 3 + 1];
        vertexData[offset + 7] = m.normals[i * 3 + 2];
      } else {
        vertexData[offset + 5] = 0;
        vertexData[offset + 6] = 0;
        vertexData[offset + 7] = 1;
      }

      // Tangent
      if (m.tangents) {
        vertexData[offset + 8] = m.tangents[i * 3];
        vertexData[offset + 9] = m.tangents[i * 3 + 1];
        vertexData[offset + 10] = m.tangents[i * 3 + 2];
      } else {
        vertexData[offset + 8] = 1;
        vertexData[offset + 9] = 0;
        vertexData[offset + 10] = 0;
      }

      // Bitangent
      if (m.bitangents) {
        vertexData[offset + 11] = m.bitangents[i * 3];
        vertexData[offset + 12] = m.bitangents[i * 3 + 1];
        vertexData[offset + 13] = m.bitangents[i * 3 + 2];
      } else {
        vertexData[offset + 11] = 0;
        vertexData[offset + 12] = 1;
        vertexData[offset + 13] = 0;
      }
    }

    // Create and upload VBO
    m.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, m.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, vertexData, gl.STATIC_DRAW);

    // Create and upload IBO
    m.ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.ibo);

    // Flip winding order (CW -> CCW) to fix inside-out rendering
    const indices = new (m.indices instanceof Uint16Array ? Uint16Array : Uint32Array)(m.indices.length);
    for (let i = 0; i < m.indices.length; i += 3) {
      indices[i] = m.indices[i];
      indices[i + 1] = m.indices[i + 2];
      indices[i + 2] = m.indices[i + 1];
    }

    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

    // Create VAO capturing VBO layout + IBO binding
    const stride = 56;
    m.vao = GL.CreateVAO(m.vbo, [
      { location: ATTRIB_LOCATIONS.aPosition, components: 3, type: gl.FLOAT, normalized: false, stride, offset: 0 },
      { location: ATTRIB_LOCATIONS.aTexCoord, components: 2, type: gl.FLOAT, normalized: false, stride, offset: 12 },
      { location: ATTRIB_LOCATIONS.aNormal, components: 3, type: gl.FLOAT, normalized: false, stride, offset: 20 },
    ], m.ibo);

    Con.DPrint(`MeshModelRenderer.prepareModel: ${m.name} uploaded ${m.numVertices} vertices, ${m.numTriangles} triangles\n`);

    // Load texture
    this._loadTexture(m);
  }

  /**
   * Load texture for mesh model
   * @private
   * @param {import('../../common/model/MeshModel.ts').MeshModel} model The mesh model
   */
  _loadTexture(model) {
    // Try to load texture using the texture name
    // For now, just use the base name and let the texture system find it
    if (model.textureName) {
      // The texture will be loaded lazily when first needed
      // For now, we'll just store the name
      // TODO: Implement proper texture loading for external formats (PNG, JPG)
    }
  }
}
