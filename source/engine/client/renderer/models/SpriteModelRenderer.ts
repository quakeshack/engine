import { ModelRenderer } from './ModelRenderer.ts';
import { getEntityBloomEmissiveScale } from '../postprocess/BloomEffect.ts';
import { eventBus } from '../../../common/EventBus.ts';
import GL, { type GLTextureArray } from '../../GL.ts';
import Vector from '../../../../shared/Vector.ts';
import { SpriteModel } from '../../../common/model/SpriteModel.ts';
import { SpriteAnimator, SpriteSample } from '../../../common/model/sprite/SpriteAnimator.ts';
import { SpriteBlend, SpriteOrientation, SpritePhase } from '../../../common/model/sprite/SpriteTypes.ts';
import rendererCvars from '../resources/RendererCvars.ts';
import { EntityLighting } from '../lighting/EntityLighting.ts';
import { SpriteLighting } from '../../../common/model/sprite/SpriteLighting.ts';
import type { ClientEdict } from '../../ClientEntities.ts';
import type { BaseModel } from '../../../common/model/BaseModel.ts';
import { clientRuntimeState } from '../../ClientState.ts';
import Camera from '../scene/Camera.ts';


let gl: WebGL2RenderingContext = null!;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null!;
});

/**
 * Renderer for sprite models (2D billboards like explosions, particles).
 * Handles camera-facing and oriented billboards using dynamic geometry.
 */
export class SpriteModelRenderer extends ModelRenderer {
  /** The array texture bound for the sprites streamed so far, to batch sprites that share one. */
  static #boundTexture: GLTextureArray | null = null;

  /** The `uAlpha` and `uBloomEmissiveScale` the streamed sprites are drawn with; `NaN` before the first sprite of a run. */
  static #alpha = Number.NaN;
  static #emissiveScale = Number.NaN;
  static #blendMode = Number.NaN;
  /** The `uLight` the streamed sprites are drawn with. */
  static readonly #light: [number, number, number] = [Number.NaN, 1, 1];
  static readonly #wanted: [number, number, number] = [1, 1, 1];

  /** The image of the sprite being built, with the layer it fades into and how far (`aBlend` of its vertices). */
  static readonly #sample = new SpriteSample();

  /** The values of `uBlendMode` in `sprite.frag`. */
  static readonly #BLEND_MODES: Readonly<Record<SpriteBlend, number>> = {
    [SpriteBlend.alphaTest]: 0,
    [SpriteBlend.alpha]: 1,
    [SpriteBlend.additive]: 2,
  };

  /** Basis of the sprite being built. */
  static readonly #right = new Vector();
  static readonly #up = new Vector();

  /**
   * Get the model class this renderer handles.
   * @returns SpriteModel constructor.
   */
  override getModelClass(): typeof SpriteModel {
    return SpriteModel;
  }

  /**
   * Setup rendering state for sprite models.
   * Enables blending for transparent sprites.
   * @param pass Rendering pass (0=opaque, 1=transparent).
   */
  override setupRenderState(pass = 0): void {
    if (pass === 1) {
      GL.UseProgram('sprite', true);
      SpriteModelRenderer.#boundTexture = null;
      SpriteModelRenderer.#alpha = Number.NaN;
      SpriteModelRenderer.#emissiveScale = Number.NaN;
      SpriteModelRenderer.#blendMode = Number.NaN;
      SpriteModelRenderer.#light[0] = Number.NaN;
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
   * @returns True because sprites are now emitted into the unified transparent pass.
   */
  override rendersTransparentPass(_model: BaseModel, _entity: ClientEdict): boolean {
    return true;
  }

  /**
   * Render a single sprite model entity.
   * Generates billboard geometry dynamically based on the sprite's orientation.
   * @param model The sprite model to render.
   * @param entity The entity being rendered.
   * @param pass Rendering pass (0=opaque, 1=transparent).
   */
  override render(model: BaseModel, entity: ClientEdict, pass = 0): void {
    if (pass === 0) {
      return; // Sprites only render in transparent pass
    }

    const spriteModel = model as SpriteModel;
    const asset = spriteModel.asset;

    if (asset === null || asset.texture === null || asset.frames.length === 0) {
      return;
    }

    const program = GL.UseProgram('sprite', true)!;

    // the quads are drawn at the next flush, so what the uniforms say has to be the same for all of them
    const emissiveScale = getEntityBloomEmissiveScale(entity.effects);

    const blendMode = SpriteModelRenderer.#BLEND_MODES[asset.blend];
    const light = SpriteModelRenderer.#lightOf(spriteModel, entity);
    const current = SpriteModelRenderer.#light;

    if (entity.alpha !== SpriteModelRenderer.#alpha || emissiveScale !== SpriteModelRenderer.#emissiveScale || blendMode !== SpriteModelRenderer.#blendMode
      || light[0] !== current[0] || light[1] !== current[1] || light[2] !== current[2]) {
      GL.StreamFlush();
      gl.uniform1f(program.uAlpha!, entity.alpha);
      gl.uniform1f(program.uBloomEmissiveScale!, emissiveScale);
      gl.uniform1f(program.uBlendMode!, blendMode);
      gl.uniform3f(program.uLight!, light[0], light[1], light[2]);
      current[0] = light[0];
      current[1] = light[1];
      current[2] = light[2];
      SpriteModelRenderer.#alpha = entity.alpha;
      SpriteModelRenderer.#emissiveScale = emissiveScale;
      SpriteModelRenderer.#blendMode = blendMode;
    }

    SpriteModelRenderer.#selectImage(spriteModel, entity);

    if (SpriteModelRenderer.#boundTexture !== asset.texture) {
      asset.texture.bind(program.tTexture!, true);
      SpriteModelRenderer.#boundTexture = asset.texture;
    }

    SpriteModelRenderer.#setBasis(spriteModel.orientation, entity);
    SpriteModelRenderer.#emitQuad(entity.origin, SpriteModelRenderer.#sample);
  }

  /**
   * @returns The light a sprite is drawn with: white, or for a lit sprite the light of the map at its origin and the
   * dynamic lights that reach it.
   */
  static #lightOf(spriteModel: SpriteModel, entity: ClientEdict): readonly [number, number, number] {
    const wanted = SpriteModelRenderer.#wanted;

    if (!spriteModel.lit) {
      wanted[0] = 1;
      wanted[1] = 1;
      wanted[2] = 1;

      return wanted;
    }

    const [ambientLight, , , dynamicShadeLight] = EntityLighting.CalculateLightValues(entity);

    return SpriteLighting.combine(ambientLight, dynamicShadeLight, wanted);
  }

  /**
   * Picks the image an entity shows now into {@link SpriteModelRenderer.#sample}: its `frame` selects a frame, a
   * sequence animates on the clock the model's phase names, and a sequence with rotations shows the view the camera
   * sees it from.
   */
  static #selectImage(spriteModel: SpriteModel, entity: ClientEdict): void {
    const frames = spriteModel.frames;
    const frame = frames[entity.frame >= 0 && entity.frame < frames.length ? entity.frame : 0];
    let time = clientRuntimeState.time;
    let view = 0;

    if ('images' in frame && frame.views.length > 1) {
      const vieworg = Camera.refdef.vieworg;

      view = SpriteAnimator.viewIndex(frame.views.length, entity.angles[1], vieworg[0] - entity.origin[0], vieworg[1] - entity.origin[1]);
    }

    switch (spriteModel.phase) {
      case SpritePhase.random:
        // syncbase is 0..1, so scale it to the length of the loop or a long sequence would only spread over a second
        time += 'images' in frame ? entity.syncbase * SpriteAnimator.cycleDuration(frame) : 0.0;
        break;
      case SpritePhase.spawn:
        time -= entity.animationStartTime;
        break;
      default:
        break;
    }

    SpriteAnimator.sample(frame, time, spriteModel.asset!.interpolate && rendererCvars.interpolation.value !== 0, SpriteModelRenderer.#sample, view);
  }

  /**
   * Sets the right and up vectors the quad is built on.
   */
  static #setBasis(orientation: SpriteOrientation, entity: ClientEdict): void {
    const right = SpriteModelRenderer.#right;
    const up = SpriteModelRenderer.#up;

    switch (orientation) {
      case SpriteOrientation.parallelUpright:
        right.setTo(Camera.vright[0], Camera.vright[1], Camera.vright[2]);
        up.setTo(0.0, 0.0, 1.0);
        break;
      case SpriteOrientation.facingUpright: {
        // perpendicular to the direction towards the sprite, in the horizontal plane
        const dx = entity.origin[0] - Camera.refdef.vieworg[0];
        const dy = entity.origin[1] - Camera.refdef.vieworg[1];
        const length = Math.max(Math.hypot(dx, dy), 0.0001);
        right.setTo(dy / length, -dx / length, 0.0);
        up.setTo(0.0, 0.0, 1.0);
        break;
      }
      case SpriteOrientation.oriented: {
        const { right: entityRight, up: entityUp } = entity.angles.angleVectors();
        right.setTo(entityRight[0], entityRight[1], entityRight[2]);
        up.setTo(entityUp[0], entityUp[1], entityUp[2]);
        break;
      }
      case SpriteOrientation.parallelOriented: {
        // the view basis rolled by the entity's roll angle
        const roll = entity.angles[2] * (Math.PI / 180.0);
        const cosine = Math.cos(roll);
        const sine = Math.sin(roll);
        right.setTo(
          Camera.vright[0] * cosine + Camera.vup[0] * sine,
          Camera.vright[1] * cosine + Camera.vup[1] * sine,
          Camera.vright[2] * cosine + Camera.vup[2] * sine);
        up.setTo(
          Camera.vright[0] * -sine + Camera.vup[0] * cosine,
          Camera.vright[1] * -sine + Camera.vup[1] * cosine,
          Camera.vright[2] * -sine + Camera.vup[2] * cosine);
        break;
      }
      case SpriteOrientation.parallel:
      default:
        right.setTo(Camera.vright[0], Camera.vright[1], Camera.vright[2]);
        up.setTo(Camera.vup[0], Camera.vup[1], Camera.vup[2]);
        break;
    }
  }

  /**
   * Streams the two triangles of a quad on the current basis.
   */
  static #emitQuad(origin: Vector, sample: SpriteSample): void {
    const r = SpriteModelRenderer.#right;
    const u = SpriteModelRenderer.#up;
    const p = origin;
    const { image } = sample;
    const x1 = image.origin[0];
    const y1 = image.origin[1];
    const x2 = x1 + image.width;
    const y2 = y1 + image.height;
    const uMax = image.uvScale[0];
    const vMax = image.uvScale[1];
    const layer = image.layer;
    const nextLayer = sample.nextLayer;
    const fade = sample.fade;

    GL.StreamGetSpace(6);

    // Triangle 1: top-left, bottom-left, top-right
    GL.StreamWriteFloat3(
      p[0] + x1 * r[0] + y1 * u[0],
      p[1] + x1 * r[1] + y1 * u[1],
      p[2] + x1 * r[2] + y1 * u[2]);
    GL.StreamWriteFloat3(0.0, vMax, layer);
    GL.StreamWriteFloat2(nextLayer, fade);

    GL.StreamWriteFloat3(
      p[0] + x1 * r[0] + y2 * u[0],
      p[1] + x1 * r[1] + y2 * u[1],
      p[2] + x1 * r[2] + y2 * u[2]);
    GL.StreamWriteFloat3(0.0, 0.0, layer);
    GL.StreamWriteFloat2(nextLayer, fade);

    GL.StreamWriteFloat3(
      p[0] + x2 * r[0] + y1 * u[0],
      p[1] + x2 * r[1] + y1 * u[1],
      p[2] + x2 * r[2] + y1 * u[2]);
    GL.StreamWriteFloat3(uMax, vMax, layer);
    GL.StreamWriteFloat2(nextLayer, fade);

    // Triangle 2: top-right, bottom-left, bottom-right
    GL.StreamWriteFloat3(
      p[0] + x2 * r[0] + y1 * u[0],
      p[1] + x2 * r[1] + y1 * u[1],
      p[2] + x2 * r[2] + y1 * u[2]);
    GL.StreamWriteFloat3(uMax, vMax, layer);
    GL.StreamWriteFloat2(nextLayer, fade);

    GL.StreamWriteFloat3(
      p[0] + x1 * r[0] + y2 * u[0],
      p[1] + x1 * r[1] + y2 * u[1],
      p[2] + x1 * r[2] + y2 * u[2]);
    GL.StreamWriteFloat3(0.0, 0.0, layer);
    GL.StreamWriteFloat2(nextLayer, fade);

    GL.StreamWriteFloat3(
      p[0] + x2 * r[0] + y2 * u[0],
      p[1] + x2 * r[1] + y2 * u[1],
      p[2] + x2 * r[2] + y2 * u[2]);
    GL.StreamWriteFloat3(uMax, 0.0, layer);
    GL.StreamWriteFloat2(nextLayer, fade);
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
   * @param model The sprite model to cleanup.
   */
  override cleanupModel(model: BaseModel): void {
    (model as SpriteModel).asset?.free();
  }
}
