import { ModelRenderer } from './ModelRenderer.ts';
import { getEntityBloomEmissiveScale } from './BloomEffect.ts';
import { eventBus, getClientRegistry } from '../../registry.ts';
import GL from '../GL.ts';
import type { SpriteModel, SpriteSingleFrame, SpriteFrameImage } from '../../common/model/SpriteModel.ts';
import type { ClientEdict } from '../ClientEntities.ts';
import type { BaseModel } from '../../common/model/BaseModel.ts';

let { CL, R } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ CL, R } = getClientRegistry());
});

let gl: WebGL2RenderingContext = null!;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null!;
});

/** A resolved (non-group) sprite frame ready for rendering. */
type SpriteRenderFrame = SpriteSingleFrame | SpriteFrameImage;

/**
 * Renderer for Sprite SPR models (2D billboards like explosions, particles).
 * Handles both camera-facing and oriented billboards using dynamic geometry.
 */
export class SpriteModelRenderer extends ModelRenderer {
  /**
   * Get the model type this renderer handles.
   * @returns Mod.type.sprite (1)
   */
  override getModelType(): number {
    return 1; // Mod.type.sprite
  }

  /**
   * Setup rendering state for sprite models.
   * Enables blending for transparent sprites.
   * @param pass Rendering pass (0=opaque, 1=transparent).
   */
  override setupRenderState(pass = 0): void {
    if (pass === 1) {
      GL.UseProgram('sprite', true);
    }
  }

  /**
   * @param _model The sprite model.
   * @param _entity The entity being rendered.
   * @returns Sprites are never drawn in the opaque pass.
   */
  override rendersOpaquePass(_model: BaseModel, _entity: ClientEdict): boolean {
    return false;
  }

  /**
   * @param _model The sprite model.
   * @param _entity The entity being rendered.
   * @returns Sprites use their dedicated sprite pass rather than the sorted transparent pass.
   */
  override rendersTransparentPass(_model: BaseModel, _entity: ClientEdict): boolean {
    return false;
  }

  /**
   * Render a single sprite model entity.
   * Generates billboard geometry dynamically based on camera orientation.
   * @param model The sprite model to render.
   * @param entity The entity being rendered.
   * @param pass Rendering pass (0=opaque, 1=transparent).
   */
  override render(model: BaseModel, entity: ClientEdict, pass = 0): void {
    if (pass === 0) {
      return; // Sprites only render in transparent pass
    }

    const spriteModel = model as SpriteModel;
    const e = entity;
    const program = GL.UseProgram('sprite', true)!;

    // Prepare uniforms
    gl.uniform1f(program.uAlpha!, entity.alpha);
    gl.uniform1f(program.uBloomEmissiveScale!, getEntityBloomEmissiveScale(entity.effects));

    // Select frame
    let num = e.frame;
    if ((num >= spriteModel.numframes) || (num < 0)) {
      num = 0;
    }

    let frame: SpriteRenderFrame = spriteModel.frames[num] as SpriteRenderFrame;

    // Handle frame groups (animated sprites)
    if ((frame as { group?: boolean }).group) {
      const groupedFrame = spriteModel.frames[num] as { group: true; frames: SpriteFrameImage[] };
      const time = CL.state.time + e.syncbase;
      const groupLen = groupedFrame.frames.length - 1;
      const fullinterval = groupedFrame.frames[groupLen].interval!;
      const targettime = time - Math.floor(time / fullinterval) * fullinterval;

      let i = 0;
      for (i = 0; i < groupLen; i++) {
        if (groupedFrame.frames[i].interval! > targettime) {
          break;
        }
      }
      frame = groupedFrame.frames[i];
    }

    // Bind texture
    GL.Bind(program.tTexture!, frame.texturenum, true);

    // Calculate billboard orientation
    let r: { [n: number]: number };
    let u: { [n: number]: number };
    if (spriteModel.oriented) {
      // Sprite has fixed orientation
      const { right, up } = e.angles.angleVectors();
      r = right;
      u = up;
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
   * @param _pass Rendering pass (0=opaque, 1=transparent).
   */
  override cleanupRenderState(_pass = 0): void {
    // Flush accumulated sprite geometry
    GL.StreamFlush();
  }

  /**
   * Prepare sprite model for rendering.
   * Sprites use dynamic geometry, so no GPU resources to prepare.
   * @param _model The sprite model to prepare.
   * @param isWorldModel Whether this model is the world model.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  override prepareModel(_model: BaseModel, isWorldModel = false): void {
    // Sprites don't need GPU preparation - geometry is generated per-frame
  }

  /**
   * Free GPU resources for this sprite model.
   * Sprites don't allocate GPU resources.
   * @param _model The sprite model to cleanup.
   */
  override cleanupModel(_model: BaseModel): void {
    // Sprites don't have GPU resources to clean up
  }
}
