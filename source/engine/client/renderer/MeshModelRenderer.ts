import Vector from '../../../shared/Vector.ts';
import { ModelRenderer } from './ModelRenderer.ts';
import { getEntityBloomEmissiveScale } from './BloomEffect.ts';
import { eventBus, getClientRegistry } from '../../registry.ts';
import GL, { ATTRIB_LOCATIONS } from '../GL.ts';
import { ModelType } from '../../common/Mod.ts';
import type { MeshModel } from '../../common/model/MeshModel.ts';
import type { ClientEdict } from '../ClientEntities.ts';
import type { BaseModel } from '../../common/model/BaseModel.ts';

let { Con, R } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ Con, R } = getClientRegistry());
});

let gl: WebGL2RenderingContext = null!;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null!;
});

/**
 * Renderer for Mesh models (OBJ, IQM, GLTF, etc.).
 * Handles static mesh rendering with modern vertex attributes.
 */
export class MeshModelRenderer extends ModelRenderer {
  /**
   * Get the model type this renderer handles.
   * @returns ModelType.mesh.
   */
  override getModelType(): ModelType {
    return ModelType.mesh;
  }

  /**
   * Setup rendering state for mesh models.
   * @param _pass Rendering pass (0=opaque, 1=transparent).
   */

  override setupRenderState(_pass = 0): void {
    // Mesh models bind their own buffers and state per-entity
    // No shared setup needed at this level
  }

  /**
   * @param _model The mesh model.
   * @param _entity The entity being rendered.
   * @returns Mesh transparency is not implemented, so meshes stay in the opaque pass.
   */
  override rendersOpaquePass(_model: BaseModel, _entity: ClientEdict): boolean {
    return true;
  }

  /**
   * @param _model The mesh model.
   * @param _entity The entity being rendered.
   * @returns False because sorted transparent mesh rendering is not implemented yet.
   */
  override rendersTransparentPass(_model: BaseModel, _entity: ClientEdict): boolean {
    return false;
  }

  /**
   * Cleanup rendering state after rendering mesh models.
   * @param _pass Rendering pass (0=opaque, 1=transparent).
   */

  override cleanupRenderState(_pass = 0): void {
    // No shared cleanup needed
  }

  /**
   * Render a single mesh model entity.
   * @param model The mesh model to render.
   * @param entity The entity being rendered.
   * @param pass Rendering pass (0=opaque, 1=transparent).
   */
  override render(model: BaseModel, entity: ClientEdict, pass = 0): void {
    const clmodel = model as MeshModel;
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
      ))) {
      return;
    }

    // Ensure VBO/IBO are created
    if (!clmodel.vbo) {
      return; // Not prepared yet
    }

    // Use dedicated mesh shader
    const program = GL.UseProgram('mesh')!;

    // Bind model VAO (captures VBO layout + IBO)
    GL.BindVAO(clmodel.vao!);

    // Setup uniforms
    const viewMatrix = e.lerp.angles.toRotationMatrix();
    gl.uniform3fv(program.uOrigin!, e.lerp.origin);
    gl.uniformMatrix3fv(program.uAngles!, false, viewMatrix);

    // Lighting
    const [ambientlight, shadelight, lightPosition, dynamicShadeLight, dynamicLightPosition] = R._CalculateLightValues(e);
    gl.uniform3fv(program.uAmbientLight!, ambientlight);
    gl.uniform3fv(program.uShadeLight!, shadelight);
    gl.uniform3fv(program.uLightVec!, lightPosition);
    gl.uniform3fv(program.uDynamicShadeLight!, dynamicShadeLight);
    gl.uniform3fv(program.uDynamicLightVec!, dynamicLightPosition);
    gl.uniform1f(program.uBloomEmissiveScale!, getEntityBloomEmissiveScale(e.effects));

    // Bind texture
    if (clmodel.texture) {
      clmodel.texture.bindTo(program);
    } else {
      R.notexture.bind(program.tTexture!);
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

    // Track non-brush geometry together with alias-model poly counts in r_speeds.
    R.c_alias_polys += clmodel.numTriangles;
  }

  /**
   * Prepare mesh model for rendering (build display lists, upload to GPU).
   * @param model The mesh model to prepare.
   * @param isWorldModel Whether this model is the world model.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  override prepareModel(model: BaseModel, isWorldModel = false): void {
    const m = model as MeshModel;

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
    const srcIndices = m.indices!;
    const indices = new (srcIndices instanceof Uint16Array ? Uint16Array : Uint32Array)(srcIndices.length);
    for (let i = 0; i < srcIndices.length; i += 3) {
      indices[i] = srcIndices[i];
      indices[i + 1] = srcIndices[i + 2];
      indices[i + 2] = srcIndices[i + 1];
    }

    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

    // Create VAO capturing VBO layout + IBO binding
    const stride = 56;
    m.vao = GL.CreateVAO(m.vbo!, [
      { location: ATTRIB_LOCATIONS.aPosition, components: 3, type: gl.FLOAT, normalized: false, stride, offset: 0 },
      { location: ATTRIB_LOCATIONS.aTexCoord, components: 2, type: gl.FLOAT, normalized: false, stride, offset: 12 },
      { location: ATTRIB_LOCATIONS.aNormal, components: 3, type: gl.FLOAT, normalized: false, stride, offset: 20 },
    ], m.ibo!);

    Con.DPrint(`MeshModelRenderer.prepareModel: ${m.name} uploaded ${m.numVertices} vertices, ${m.numTriangles} triangles\n`);

    this._loadTexture(m);
  }

  /**
   * Load texture for mesh model.
   * @param model The mesh model.
   */
  private _loadTexture(model: MeshModel): void {
    // Try to load texture using the texture name
    // For now, just use the base name and let the texture system find it
    if (model.textureName) {
      // The texture will be loaded lazily when first needed
      // TODO: Implement proper texture loading for external formats (PNG, JPG)
    }
  }

  /**
   * Free GPU resources for this mesh model.
   * @param model The mesh model to cleanup.
   */
  override cleanupModel(model: BaseModel): void {
    const m = model as MeshModel;
    if (m.vao) {
      gl.deleteVertexArray(m.vao);
      m.vao = null;
    }
    if (m.vbo) {
      gl.deleteBuffer(m.vbo);
      m.vbo = null;
    }
    if (m.ibo) {
      gl.deleteBuffer(m.ibo);
      m.ibo = null;
    }
  }
}
