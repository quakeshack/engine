import W from '../../common/W.ts';
import { BrushModel } from '../../common/Mod.ts';
import { eventBus, registry } from '../../registry.mjs';

import GL, { ATTRIB_LOCATIONS, GLTexture } from '../GL.mjs';

let { Host, R } = registry;

eventBus.subscribe('registry.frozen', () => {
  Host = registry.Host;
  R = registry.R;
});

/** @type {WebGL2RenderingContext} */
let gl = null;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null;
});

/**
 * @param {number} strength Requested sky bloom strength.
 * @returns {number} Sanitized sky bloom strength.
 */
export function resolveSkyBloomEmissiveScale(strength) {
  return Number.isFinite(strength) && strength > 0.0 ? strength : 0.0;
}

/**
 * Base class for sky rendering.
 * Allows different sky rendering techniques to be implemented.
 * Right now the BSP model loader sets up the desired sky renderer.
 */
export class SkyRenderer {
  /**
   * @param {BrushModel} worldmodel current world
   */
  constructor(worldmodel) {
    this.worldmodel = worldmodel;
  }

  /**
   * Renders the stencil mask for sky surfaces.
   * @protected
   */
  _renderStencilMask() {
    // Disable color writes - we only want to mark the depth buffer where sky is visible
    gl.colorMask(false, false, false, false);

    const program = GL.UseProgram('sky-chain');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.worldmodel.cmds);
    gl.vertexAttribPointer(program.aPosition.location, 3, gl.FLOAT, false, 12, this.worldmodel.skychain);

    // Render all visible sky surfaces from the BSP tree
    // This writes to the depth buffer, creating a stencil of where sky should appear
    for (let i = 0; i < this.worldmodel.leafs.length; i++) {
      const leaf = this.worldmodel.leafs[i];

      // Skip leafs that aren't visible or don't have sky surfaces
      if (leaf.visframe !== R.visframecount || leaf.skychain === leaf.waterchain) {
        continue;
      }

      // Frustum culling
      if (R.CullBox(leaf.mins, leaf.maxs)) {
        continue;
      }

      // Draw all sky surface commands in this leaf
      for (let j = leaf.skychain; j < leaf.waterchain; j++) {
        const cmds = leaf.cmds[j];
        gl.drawArrays(gl.TRIANGLES, cmds[0], cmds[1]);
      }
    }

    // Re-enable color writes
    gl.colorMask(true, true, true, true);
  }

  init() {
  }

  shutdown() {
  }

  render() {
  }
};

/**
 * Quake 1 style sky rendering.
 * It accepts the classic 256x128 sky texture, where the top half is the solid sky
 * and the bottom half is the alphablended sky.
 */
export class Quake1Sky extends SkyRenderer {
  #solidskytexture = new GLTexture('r_solidsky', 128, 128);
  #alphaskytexture = new GLTexture('r_alphasky', 128, 128);

  #skybox = null;

  /**
   * VAO for the sky dome VBO (position-only, 12-byte stride).
   * @type {WebGLVertexArrayObject|null}
   */
  #skyboxVAO = null;

  /**
   * Procedurally generates a dome mesh for skybox rendering.
   *
   * Creates a partial hemisphere (dome) using a grid of triangles.
   * The dome is centered at the origin and extends from 0° to 90° in both
   * horizontal directions, covering one octant of a sphere.
   *
   * The mesh is rendered 8 times with different scale transforms to create
   * a complete spherical skybox.
   *
   * Grid structure:
   * - 4 vertical segments (0-7 in steps of 2)
   * - 8 horizontal segments (0-8)
   * - Each grid cell becomes 2 triangles
   * - Plus a triangle fan at the top (zenith)
   * - Total: 180 vertices (60 triangles)
   */
  #makeSky() {
    // Pre-compute sine values for angles from 0° to 90° in steps of 11.25° (π/16)
    // These define the dome's curvature
    const sin = Array.from({ length: 9 }, (_, i) =>
      Number(Math.sin(i * Math.PI / 16).toFixed(6)),
    );
    let vecs = []; let i; let j;

    // Build the dome mesh in 4 vertical segments
    for (i = 0; i < 7; i += 2) {
      // Triangle fan at the top (zenith) of this segment
      // Connects the peak (0, 0, 1) to the top edge of the dome
      vecs = vecs.concat(
        [
          0.0, 0.0, 1.0,                                          // Zenith point
          sin[i + 2] * sin[1], sin[6 - i] * sin[1], sin[7],      // Edge point 1
          sin[i] * sin[1], sin[8 - i] * sin[1], sin[7],          // Edge point 2
        ]);

      // Build the dome grid: 8 horizontal rings, each forming a strip of quads
      // Each quad is split into 2 triangles
      for (j = 0; j < 7; j++) {
        // The vertices form a spherical coordinate grid:
        // sin[i] controls the X/Y position (azimuth angle)
        // sin[j] controls the Z height (elevation angle)
        vecs = vecs.concat(
          [
            // Triangle 1 of the quad
            sin[i] * sin[8 - j], sin[8 - i] * sin[8 - j], sin[j],           // Bottom-left
            sin[i] * sin[7 - j], sin[8 - i] * sin[7 - j], sin[j + 1],       // Top-left
            sin[i + 2] * sin[7 - j], sin[6 - i] * sin[7 - j], sin[j + 1],   // Top-right

            // Triangle 2 of the quad
            sin[i] * sin[8 - j], sin[8 - i] * sin[8 - j], sin[j],           // Bottom-left
            sin[i + 2] * sin[7 - j], sin[6 - i] * sin[7 - j], sin[j + 1],   // Top-right
            sin[i + 2] * sin[8 - j], sin[6 - i] * sin[8 - j], sin[j],       // Bottom-right
          ]);
      }
    }

    this.#skybox = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#skybox);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vecs), gl.STATIC_DRAW);

    this.#skyboxVAO = GL.CreateVAO(this.#skybox, [
      { location: ATTRIB_LOCATIONS.aPosition, components: 3, type: gl.FLOAT, normalized: false, stride: 12, offset: 0 },
    ]);
  }

  init() {
    this.#makeSky();

    this.#alphaskytexture.lockTextureMode('GL_NEAREST');
    this.#solidskytexture.lockTextureMode('GL_LINEAR');
  }

  shutdown() {
    this.#solidskytexture.free();
    this.#alphaskytexture.free();

    if (this.#skybox) {
      gl.deleteBuffer(this.#skybox);
      this.#skybox = null;
    }
    if (this.#skyboxVAO) {
      gl.deleteVertexArray(this.#skyboxVAO);
      this.#skyboxVAO = null;
    }
  }

  #renderSkyboxDome() {
    // Configure depth testing: only draw sky where depth > existing (i.e., behind everything)
    gl.depthFunc(gl.GREATER);
    gl.depthMask(false); // Don't write to depth buffer
    gl.disable(gl.CULL_FACE); // Need to see both sides of the dome

    // Set up the sky shader with scrolling textures
    const program = GL.UseProgram('sky');
    // Two scrolling layers at different speeds for parallax effect
    gl.uniform2f(program.uTime, (Host.realtime * 0.125) % 1.0, (Host.realtime * 0.03125) % 1.0);
    gl.uniform1f(program.uBloomEmissiveScale, resolveSkyBloomEmissiveScale(R.bloomSkyStrength?.value ?? 0.0));
    this.#solidskytexture.bind(program.tSolid); // Base sky layer
    this.#alphaskytexture.bind(program.tAlpha); // Overlay layer (e.g., clouds)

    // Bind the procedurally-generated dome mesh
    GL.BindVAO(this.#skyboxVAO);

    // Render the sky dome 8 times - once for each octant of a sphere
    // The uScale uniform transforms the base dome mesh to cover different octants
    // This creates a full spherical skybox from a single dome mesh

    // Octants with positive X
    gl.uniform3f(program.uScale, 2.0, -2.0, 1.0);  // +X, -Y, +Z
    gl.drawArrays(gl.TRIANGLES, 0, 180);
    gl.uniform3f(program.uScale, 2.0, -2.0, -1.0); // +X, -Y, -Z
    gl.drawArrays(gl.TRIANGLES, 0, 180);

    gl.uniform3f(program.uScale, 2.0, 2.0, 1.0);   // +X, +Y, +Z
    gl.drawArrays(gl.TRIANGLES, 0, 180);
    gl.uniform3f(program.uScale, 2.0, 2.0, -1.0);  // +X, +Y, -Z
    gl.drawArrays(gl.TRIANGLES, 0, 180);

    // Octants with negative X
    gl.uniform3f(program.uScale, -2.0, -2.0, 1.0);  // -X, -Y, +Z
    gl.drawArrays(gl.TRIANGLES, 0, 180);
    gl.uniform3f(program.uScale, -2.0, -2.0, -1.0); // -X, -Y, -Z
    gl.drawArrays(gl.TRIANGLES, 0, 180);

    gl.uniform3f(program.uScale, -2.0, 2.0, 1.0);   // -X, +Y, +Z
    gl.drawArrays(gl.TRIANGLES, 0, 180);
    gl.uniform3f(program.uScale, -2.0, 2.0, -1.0);  // -X, +Y, -Z
    gl.drawArrays(gl.TRIANGLES, 0, 180);

    GL.UnbindVAO();

    // Restore default GL state
    gl.enable(gl.CULL_FACE);
    gl.depthMask(true);
    gl.depthFunc(gl.LESS);
  }

  /**
   * Renders the skybox using a two-pass technique:
   * 1. First pass: Render sky surfaces to depth buffer only (stencil mask)
   * 2. Second pass: Render the actual skybox dome where the mask was written
   *
   * This ensures the sky only appears where sky-textured surfaces are visible,
   * not behind walls or geometry. The skybox itself is rendered 8 times (once
   * for each octant of the sphere) using a procedurally-generated dome mesh.
   */
  render() {
    console.assert(this.#skybox !== null, 'Skybox mesh not initialized');

    this._renderStencilMask();
    this.#renderSkyboxDome();
  }

  /**
   * Initializes the two-layer skybox textures from Quake's sky texture format.
   *
   * Quake sky textures are 256x128 8-bit indexed images split into two layers:
   * - Left half (0-127): Alpha layer with transparency (clouds/overlay)
   * - Right half (128-255): Solid background layer
   *
   * Each layer is extracted as a 128x128 texture and converted from 8-bit
   * palette indices to 32-bit RGBA. The layers scroll at different speeds
   * in the shader to create a parallax depth effect.
   * @param {Uint8Array} indexedTexture - 256x128 8-bit indexed sky texture data
   */
  setSkyTexture(indexedTexture) {
    const trans = new ArrayBuffer(65536); // 128x128x4 bytes
    const trans32 = new Uint32Array(trans);

    // Extract the SOLID (background) layer from the right half of the texture
    for (let i = 0; i < 128; i++) {
      for (let j = 0; j < 128; j++) {
        // Source: right half starts at offset 128 in each row (256-pixel wide row)
        // Destination: 128x128 texture
        trans32[(i << 7) + j] = W.d_8to24table[indexedTexture[(i << 8) + j + 128]] + 0xff000000;
      }
    }

    this.#solidskytexture.upload(new Uint8Array(trans));

    // Extract the ALPHA (overlay) layer from the left half of the texture
    for (let i = 0; i < 128; i++) {
      for (let j = 0; j < 128; j++) {
        const p = (i << 8) + j; // Left half of the 256-wide texture
        if (indexedTexture[p] !== 0) {
          // Non-zero palette index: convert to RGBA with full opacity
          trans32[(i << 7) + j] = W.d_8to24table[indexedTexture[p]] + 0xff000000;
        } else {
          // Palette index 0: treat as transparent (for clouds)
          trans32[(i << 7) + j] = 0;
        }
      }
    }

    this.#alphaskytexture.upload(new Uint8Array(trans));
  }
};

/**
 * GoldSrc style simple skybox rendering.
 * Accepts 6 separate textures for each face of the skybox cube.
 */
export class SimpleSkyBox extends SkyRenderer {
  #front = /** @type {GLTexture|null} */ (null);
  #back = /** @type {GLTexture|null} */ (null);
  #left = /** @type {GLTexture|null} */ (null);
  #right = /** @type {GLTexture|null} */ (null);
  #up = /** @type {GLTexture|null} */ (null);
  #down = /** @type {GLTexture|null} */ (null);

  #cubeBuffer = null;

  /**
   * VAO for the skybox cube VBO (position+texcoord+normal, 32-byte stride).
   * @type {WebGLVertexArrayObject|null}
   */
  #cubeVAO = null;

  setSkyTextures(front, back, left, right, up, down) {
    this.#front = front;
    this.#back = back;
    this.#left = left;
    this.#right = right;
    this.#up = up;
    this.#down = down;

    this.#front.wrapClamped();
    this.#back.wrapClamped();
    this.#left.wrapClamped();
    this.#right.wrapClamped();
    this.#up.wrapClamped();
    this.#down.wrapClamped();
  }

  init() {
    const s = 16384.0;
    const verts = [];
    const push = (x, y, z, u, v, nx, ny, nz) => {
      verts.push(x, y, z, u, v, nx, ny, nz);
    };

    // Front (+X)
    const nFront = [1, 0, 0];
    push(s,s,-s, 0,1, ...nFront);
    push(s,-s,-s, 1,1, ...nFront);
    push(s,-s,s, 1,0, ...nFront);
    push(s,s,-s, 0,1, ...nFront);
    push(s,-s,s, 1,0, ...nFront);
    push(s,s,s, 0,0, ...nFront);

    // Back (-X)
    const nBack = [-1, 0, 0];
    push(-s,-s,-s, 0,1, ...nBack);
    push(-s,s,-s, 1,1, ...nBack);
    push(-s,s,s, 1,0, ...nBack);
    push(-s,-s,-s, 0,1, ...nBack);
    push(-s,s,s, 1,0, ...nBack);
    push(-s,-s,s, 0,0, ...nBack);

    // Left (+Y)
    const nLeft = [0, 1, 0];
    push(-s,s,-s, 0,1, ...nLeft);
    push(s,s,-s, 1,1, ...nLeft);
    push(s,s,s, 1,0, ...nLeft);
    push(-s,s,-s, 0,1, ...nLeft);
    push(s,s,s, 1,0, ...nLeft);
    push(-s,s,s, 0,0, ...nLeft);

    // Right (-Y)
    const nRight = [0, -1, 0];
    push(s,-s,-s, 0,1, ...nRight);
    push(-s,-s,-s, 1,1, ...nRight);
    push(-s,-s,s, 1,0, ...nRight);
    push(s,-s,-s, 0,1, ...nRight);
    push(-s,-s,s, 1,0, ...nRight);
    push(s,-s,s, 0,0, ...nRight);

    // Up (+Z)
    const nUp = [0, 0, 1];
    push(s,s,s, 1,1, ...nUp);
    push(s,-s,s, 1,0, ...nUp);
    push(-s,-s,s, 0,0, ...nUp);
    push(s,s,s, 1,1, ...nUp);
    push(-s,-s,s, 0,0, ...nUp);
    push(-s,s,s, 0,1, ...nUp);

    // Down (-Z)
    const nDown = [0, 0, -1];
    push(s,-s,-s, 0,0, ...nDown);
    push(s,s,-s, 0,1, ...nDown);
    push(-s,s,-s, 1,1, ...nDown);
    push(s,-s,-s, 0,0, ...nDown);
    push(-s,s,-s, 1,1, ...nDown);
    push(-s,-s,-s, 1,0, ...nDown);

    this.#cubeBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#cubeBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);

    this.#cubeVAO = GL.CreateVAO(this.#cubeBuffer, [
      { location: ATTRIB_LOCATIONS.aPosition, components: 3, type: gl.FLOAT, normalized: false, stride: 32, offset: 0 },
      { location: ATTRIB_LOCATIONS.aTexCoord, components: 2, type: gl.FLOAT, normalized: false, stride: 32, offset: 12 },
      { location: ATTRIB_LOCATIONS.aNormal, components: 3, type: gl.FLOAT, normalized: false, stride: 32, offset: 20 },
    ]);
  }

  shutdown() {
    if (this.#cubeBuffer) {
      gl.deleteBuffer(this.#cubeBuffer);
      this.#cubeBuffer = null;
    }
    if (this.#cubeVAO) {
      gl.deleteVertexArray(this.#cubeVAO);
      this.#cubeVAO = null;
    }

    this.#front = null;
    this.#back = null;
    this.#left = null;
    this.#right = null;
    this.#up = null;
    this.#down = null;
  }

  render() {
    if (!this.#front) {
      return;
    }

    this._renderStencilMask();

    gl.depthFunc(gl.GREATER);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);

    const program = GL.UseProgram('mesh');
    gl.uniform3fv(program.uOrigin, R.refdef.vieworg);
    gl.uniformMatrix3fv(program.uAngles, false, GL.identity);
    gl.uniform3f(program.uAmbientLight, 1.0, 1.0, 1.0);
    gl.uniform3f(program.uShadeLight, 0.0, 0.0, 0.0);
    gl.uniform3f(program.uDynamicShadeLight, 0.0, 0.0, 0.0);
    gl.uniform3f(program.uLightVec, 0.0, 0.0, 1.0);
    gl.uniform1f(program.uAlpha, 1.0);
    gl.uniform1f(program.uBloomEmissiveScale, resolveSkyBloomEmissiveScale(R.bloomSkyStrength?.value ?? 0.0));

    if (program.tShadowMap0 !== undefined && R.shadow_textures?.[0]) {
      GL.Bind(program.tShadowMap0, R.shadow_textures[0]);
    }
    if (program.tShadowMap1 !== undefined && R.shadow_textures?.[1]) {
      GL.Bind(program.tShadowMap1, R.shadow_textures[1]);
    }
    if (program.tShadowMap2 !== undefined && R.shadow_textures?.[2]) {
      GL.Bind(program.tShadowMap2, R.shadow_textures[2]);
    }
    if (program.tPointShadowMap !== undefined && R.point_shadow_texture) {
      GL.BindCube(program.tPointShadowMap, R.point_shadow_texture);
    }

    GL.BindVAO(this.#cubeVAO);

    const faces = [this.#front, this.#back, this.#right, this.#left, this.#up, this.#down];
    for (let i = 0; i < 6; i++) {
        if (faces[i]) {
            faces[i].bind(0);
            gl.drawArrays(gl.TRIANGLES, i * 6, 6);
        }
    }

    GL.UnbindVAO();
    gl.enable(gl.CULL_FACE);
    gl.depthMask(true);
    gl.depthFunc(gl.LESS);
  }
};
