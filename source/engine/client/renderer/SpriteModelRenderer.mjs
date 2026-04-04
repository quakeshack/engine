import { ModelRenderer } from './ModelRenderer.mjs';
import { getEntityBloomEmissiveScale } from './BloomEffect.mjs';
import { eventBus, registry } from '../../registry.mjs';
import GL from '../GL.mjs';

let { CL, R } = registry;

eventBus.subscribe('registry.frozen', () => {
  ({ CL, R } = registry);
});

let gl = /** @type {WebGL2RenderingContext} */ (null);

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null;
});

/**
 * Renderer for Sprite SPR models (2D billboards like explosions, particles).
 * Handles both camera-facing and oriented billboards using dynamic geometry.
 */
export class SpriteModelRenderer extends ModelRenderer {
  /**
   * Get the model type this renderer handles
   * @returns {number} Mod.type.sprite (1)
   */
  getModelType() {
    return 1; // Mod.type.sprite
  }

  /**
   * Setup rendering state for sprite models.
   * Enables blending for transparent sprites.
   * @param {number} pass Rendering pass (0=opaque, 1=transparent)
   * @returns {object|null} The shader program or null if not in sprite pass
   */
  setupRenderState(pass = 0) {
    if (pass === 1) {
      // Sprites are typically rendered in transparent pass
      const program = GL.UseProgram('sprite', true);
      return program;
    }
    return null;
  }

  /**
   * @param {import('../../common/model/SpriteModel.ts').SpriteModel} _model The sprite model
   * @param {import('../ClientEntities.ts').ClientEdict} _entity The entity being rendered
   * @returns {boolean} Sprites are never drawn in the opaque pass
   */
  // eslint-disable-next-line no-unused-vars
  rendersOpaquePass(_model, _entity) {
    return false;
  }

  /**
   * @param {import('../../common/model/SpriteModel.ts').SpriteModel} _model The sprite model
   * @param {import('../ClientEntities.ts').ClientEdict} _entity The entity being rendered
   * @returns {boolean} Sprites use their dedicated sprite pass rather than the sorted transparent pass
   */
  // eslint-disable-next-line no-unused-vars
  rendersTransparentPass(_model, _entity) {
    return false;
  }

  /**
   * Render a single sprite model entity.
   * Generates billboard geometry dynamically based on camera orientation.
   * @param {import('../../common/model/SpriteModel.ts').SpriteModel} model The sprite model to render
   * @param {import('../ClientEntities.ts').ClientEdict} entity The entity being rendered
   * @param {number} pass Rendering pass (0=opaque, 1=transparent)
   */
  render(model, entity, pass = 0) {
    if (pass === 0) {
      return; // Sprites only render in transparent pass
    }

    const e = entity;
    const program = GL.UseProgram('sprite', true);

    // Prepare uniforms
    gl.uniform1f(program.uAlpha, entity.alpha);
    gl.uniform1f(program.uBloomEmissiveScale, getEntityBloomEmissiveScale(entity.effects));

    // Select frame
    let num = e.frame;
    if ((num >= model.numframes) || (num < 0)) {
      if (registry.Con) {
        registry.Con.DPrint('SpriteModelRenderer: no such frame ' + num + '\n');
      }
      num = 0;
    }

    let frame = model.frames[num];

    // Handle frame groups (animated sprites)
    if (frame.group === true) {
      const time = CL.state.time + e.syncbase;
      num = frame.frames.length - 1;
      const fullinterval = frame.frames[num].interval;
      const targettime = time - Math.floor(time / fullinterval) * fullinterval;

      let i = 0;
      for (i = 0; i < num; i++) {
        if (frame.frames[i].interval > targettime) {
          break;
        }
      }
      frame = frame.frames[i];
    }

    // TODO: set uInterpolation, frames

    // Bind texture
    GL.Bind(program.tTexture, frame.texturenum, true);

    // Calculate billboard orientation
    let r, u;
    if (model.oriented === true) {
      // Sprite has fixed orientation
      const {right, up} = e.angles.angleVectors();
      [r, u] = [right, up];
    } else {
      // Sprite faces camera
      r = R.vright;
      u = R.vup;
    }

    // Build billboard quad geometry
    const p = e.origin;
    const x1 = frame.origin[0];
    const y1 = frame.origin[1];
    const x2 = x1 + frame.width;
    const y2 = y1 + frame.height;

    // TODO: use precomputed Vertex Array

    // Write 6 vertices (2 triangles) to stream buffer
    GL.StreamGetSpace(6);

    // Triangle 1: top-left, bottom-left, top-right
    GL.StreamWriteFloat3(
      p[0] + x1 * r[0] + y1 * u[0],
      p[1] + x1 * r[1] + y1 * u[1],
      p[2] + x1 * r[2] + y1 * u[2]);
    GL.StreamWriteFloat2(0.0, 1.0);

    GL.StreamWriteFloat3(
      p[0] + x1 * r[0] + y2 * u[0],
      p[1] + x1 * r[1] + y2 * u[1],
      p[2] + x1 * r[2] + y2 * u[2]);
    GL.StreamWriteFloat2(0.0, 0.0);

    GL.StreamWriteFloat3(
      p[0] + x2 * r[0] + y1 * u[0],
      p[1] + x2 * r[1] + y1 * u[1],
      p[2] + x2 * r[2] + y1 * u[2]);
    GL.StreamWriteFloat2(1.0, 1.0);

    // Triangle 2: top-right, bottom-left, bottom-right
    GL.StreamWriteFloat3(
      p[0] + x2 * r[0] + y1 * u[0],
      p[1] + x2 * r[1] + y1 * u[1],
      p[2] + x2 * r[2] + y1 * u[2]);
    GL.StreamWriteFloat2(1.0, 1.0);

    GL.StreamWriteFloat3(
      p[0] + x1 * r[0] + y2 * u[0],
      p[1] + x1 * r[1] + y2 * u[1],
      p[2] + x1 * r[2] + y2 * u[2]);
    GL.StreamWriteFloat2(0.0, 0.0);

    GL.StreamWriteFloat3(
      p[0] + x2 * r[0] + y2 * u[0],
      p[1] + x2 * r[1] + y2 * u[1],
      p[2] + x2 * r[2] + y2 * u[2]);
    GL.StreamWriteFloat2(1.0, 0.0);
  }

  /**
   * Cleanup rendering state after sprite models.
   * Flushes the stream buffer to draw all sprites.
   * @param {number} [_pass] Rendering pass (0=opaque, 1=transparent)
   */
  // eslint-disable-next-line no-unused-vars
  cleanupRenderState(_pass = 0) {
    // Flush accumulated sprite geometry
    GL.StreamFlush();
  }

  /**
   * Prepare sprite model for rendering.
   * Sprites use dynamic geometry, so no GPU resources to prepare.
   * @param {import('../../common/model/SpriteModel.ts').SpriteModel} _model The sprite model to prepare
   * @param {boolean} isWorldModel Whether this model is the world model
   */
  // eslint-disable-next-line no-unused-vars
  prepareModel(_model, isWorldModel = false) {
    // Sprites don't need GPU preparation - geometry is generated per-frame
  }

  /**
   * Free GPU resources for this sprite model.
   * Sprites don't allocate GPU resources.
   * @param {import('../../common/model/SpriteModel.ts').SpriteModel} _model The sprite model to cleanup
   */
  // eslint-disable-next-line no-unused-vars
  cleanupModel(_model) {
    // Sprites don't have GPU resources to clean up
  }
}
