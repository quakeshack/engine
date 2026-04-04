import Vector from '../../../shared/Vector.ts';
import { ModelRenderer } from './ModelRenderer.ts';
import { getEntityBloomEmissiveScale } from './BloomEffect.ts';
import { eventBus, getClientRegistry } from '../../registry.ts';
import GL from '../GL.ts';
import W from '../../common/W.ts';
import { effect } from '../../../shared/Defs.ts';
import type { AliasModel, AliasSingleFrame, AliasGroupedFrameEntry, AliasSingleSkin, AliasGroupedSkinEntry } from '../../common/model/AliasModel.ts';
import type { ClientEdict } from '../ClientEntities.ts';
import type { BaseModel } from '../../common/model/BaseModel.ts';

let { CL, Host, R, Con } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ CL, Host, R, Con } = getClientRegistry());
});

let gl: WebGL2RenderingContext = null!;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null!;
});

/** A frame that can be directly used for rendering (has cmdofs). */
type AliasRenderFrame = AliasSingleFrame | AliasGroupedFrameEntry;

/** A resolved (non-group) skin that can be directly used for rendering. */
type AliasRenderSkin = AliasSingleSkin | AliasGroupedSkinEntry;

/** Selected frame pair and interpolation factor returned by {@link AliasModelRenderer._selectFrames}. */
interface AliasFrameSelection {
  frameA: AliasRenderFrame;
  frameB: AliasRenderFrame;
  targettime: number;
}

/**
 * Renderer for Alias MDL models (animated mesh models like monsters, weapons, items).
 * Handles frame interpolation, skinning, and player color translation.
 */
export class AliasModelRenderer extends ModelRenderer {
  /**
   * Get the model type this renderer handles.
   * @returns Mod.type.alias (2)
   */
  override getModelType(): number {
    return 2; // Mod.type.alias
  }

  /**
   * Setup rendering state for alias models.
   * @param _pass Rendering pass (0=opaque, 1=transparent).
   */

  override setupRenderState(_pass = 0): void {
    // Alias models setup their own state per-entity (different shaders for players)
    // No shared setup needed at this level
  }

  /**
   * @param _model The alias model.
   * @param entity The entity being rendered.
   * @returns True when this alias model should render in the opaque pass.
   */
  override rendersOpaquePass(_model: BaseModel, entity: ClientEdict): boolean {
    return entity.alpha >= 1.0;
  }

  /**
   * @param _model The alias model.
   * @param entity The entity being rendered.
   * @returns True when this alias model should render in the sorted transparent pass.
   */
  override rendersTransparentPass(_model: BaseModel, entity: ClientEdict): boolean {
    return entity.alpha > 0.0 && entity.alpha < 1.0;
  }

  /**
   * Render a single alias model entity.
   * Handles frustum culling, frame interpolation, skinning, and player color translation.
   * @param model The alias model to render.
   * @param entity The entity being rendered.
   * @param pass Rendering pass (0=opaque, 1=transparent).
   */
  override render(model: BaseModel, entity: ClientEdict, pass = 0): void {
    const clmodel = model as AliasModel;
    const e = entity;

    // Frustum culling
    if (R.CullBox(
      new Vector(
        e.origin[0] - clmodel.boundingradius,
        e.origin[1] - clmodel.boundingradius,
        e.origin[2] - clmodel.boundingradius,
      ),
      new Vector(
        e.origin[0] + clmodel.boundingradius,
        e.origin[1] + clmodel.boundingradius,
        e.origin[2] + clmodel.boundingradius,
      ))) {
      return;
    }

    // Select shader program (player vs normal)
    let program;
    if (e.colormap !== 0 && clmodel.player && R.nocolors.value === 0) {
      program = GL.UseProgram('player');

      // Calculate player colors
      let top = (CL.state.scores[e.colormap - 1].colors & 0xf0) + 4;
      let bottom = ((CL.state.scores[e.colormap - 1].colors & 0xf) << 4) + 4;
      if (top <= 127) {
        top += 7;
      }
      if (bottom <= 127) {
        bottom += 7;
      }
      top = W.d_8to24table[top];
      bottom = W.d_8to24table[bottom];

      // Set player color uniforms
      gl.uniform3f(program!.uTop!, top & 0xff, (top >> 8) & 0xff, top >> 16);
      gl.uniform3f(program!.uBottom!, bottom & 0xff, (bottom >> 8) & 0xff, bottom >> 16);
    } else {
      program = GL.UseProgram('alias');
    }

    // Setup transforms
    gl.uniform3fv(program!.uOrigin!, e.lerp.origin);
    gl.uniformMatrix3fv(program!.uAngles!, false, e.lerp.angles.toRotationMatrix());

    // Setup lighting
    const [ambientlight, shadelight, lightVector, dynamicShadeLight, dynamicLightVector] = R._CalculateLightValues(e);
    gl.uniform3fv(program!.uAmbientLight!, ambientlight);
    gl.uniform3fv(program!.uShadeLight!, shadelight);
    gl.uniform3fv(program!.uLightVec!, lightVector);
    gl.uniform3fv(program!.uDynamicShadeLight!, dynamicShadeLight);
    gl.uniform3fv(program!.uDynamicLightVec!, dynamicLightVector);

    // Update performance counter
    R.c_alias_polys += clmodel._num_tris;

    // Select animation frames
    const { frameA, frameB, targettime } = AliasModelRenderer._selectFrames(clmodel, e);

    // Setup interpolation
    gl.uniform1f(program!.uInterpolation!, R.interpolation.value && (e.effects & effect.EF_MUZZLEFLASH) === 0 ? Math.min(1, Math.max(0, targettime)) : 0);
    gl.uniform1f(program!.uTime!, Host.realtime);
    gl.uniform1f(program!.uAlpha!, e.alpha);
    gl.uniform1f(program!.uBloomEmissiveScale!, getEntityBloomEmissiveScale(e.effects));

    // Bind vertex buffer and setup attributes
    gl.bindBuffer(gl.ARRAY_BUFFER, clmodel.cmds);
    gl.vertexAttribPointer(program!.aPositionA!.location, 3, gl.FLOAT, false, 24, frameA.cmdofs!);
    gl.vertexAttribPointer(program!.aPositionB!.location, 3, gl.FLOAT, false, 24, frameB.cmdofs!);
    gl.vertexAttribPointer(program!.aNormal!.location, 3, gl.FLOAT, false, 24, frameA.cmdofs! + 12);
    gl.vertexAttribPointer(program!.aTexCoord!.location, 2, gl.FLOAT, false, 0, 0);

    // Select and bind skin texture
    const skin = this._selectSkin(clmodel, e);
    skin.texturenum!.bind(program!.tTexture!);
    (skin.luminanceTexture || R.blacktexture).bind(program!.tLuminance!);
    if (clmodel.player) {
      skin.playertexture!.bind(program!.tPlayer!);
    }

    // Bind local shadow maps
    if (program!.tShadowMap0 !== undefined && R.shadow_textures?.[0]) {
      GL.Bind(program!.tShadowMap0, R.shadow_textures[0]);
    }
    if (program!.tShadowMap1 !== undefined && R.shadow_textures?.[1]) {
      GL.Bind(program!.tShadowMap1, R.shadow_textures[1]);
    }
    if (program!.tShadowMap2 !== undefined && R.shadow_textures?.[2]) {
      GL.Bind(program!.tShadowMap2, R.shadow_textures[2]);
    }

    // Bind point light cube shadow map
    if (program!.tPointShadowMap !== undefined && R.point_shadow_texture) {
      GL.BindCube(program!.tPointShadowMap, R.point_shadow_texture);
    }

    if (pass === 2) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }

    // Draw the model
    gl.drawArrays(gl.TRIANGLES, 0, clmodel._num_tris * 3);

    if (pass === 2) {
      gl.disable(gl.BLEND);
    }
  }

  /**
   * Select animation frames for rendering with interpolation.
   * @param clmodel The alias model.
   * @param e The entity.
   * @returns Selected frames and interpolation factor.
   */
  static _selectFrames(clmodel: AliasModel, e: ClientEdict): AliasFrameSelection {
    const time = CL.state.time + e.syncbase;
    let num = e.frame;

    // Validate frame number
    if ((num >= clmodel.frames.length) || (num < 0)) {
      Con.DPrint(`AliasModelRenderer: no such frame ${num}\n`);
      num = 0;
    }

    const frameGroup = clmodel.frames[num];
    let frameA: AliasRenderFrame;
    let frameB: AliasRenderFrame;
    let targettime = 0;

    // Handle frame groups (animated sequences)
    if (frameGroup.group) {
      const groupLen = frameGroup.frames.length - 1;
      const fullinterval = frameGroup.frames[groupLen].interval;
      frameA = frameGroup.frames[0];
      frameB = frameGroup.frames[1 % frameGroup.frames.length];
      targettime = time - Math.floor(time / fullinterval) * fullinterval;

      for (let i = 0; i < groupLen; i++) {
        if (frameGroup.frames[i].interval > targettime) {
          frameA = frameGroup.frames[i];
          frameB = frameGroup.frames[(i + 1) % frameGroup.frames.length];
          break;
        }
      }
    } else if (R.interpolation.value && (e.effects & effect.EF_MUZZLEFLASH) === 0) {
      // Handle lerp-based interpolation
      const [previousFrame, nextFrame, f] = e.lerp.frame;
      frameA = clmodel.frames[previousFrame] as AliasRenderFrame;
      frameB = clmodel.frames[nextFrame] as AliasRenderFrame;
      targettime = f;
    } else {
      frameA = frameGroup;
      frameB = frameGroup;
    }

    return { frameA, frameB, targettime };
  }

  /**
   * Select skin texture for rendering (handles skin groups and animation).
   * @param clmodel The alias model.
   * @param e The entity.
   * @returns Selected skin texture entry.
   */
  private _selectSkin(clmodel: AliasModel, e: ClientEdict): AliasRenderSkin {
    const time = CL.state.time + e.syncbase;
    let num = e.skinnum;

    // Validate skin number
    if ((num >= clmodel.skins.length) || (num < 0)) {
      Con.DPrint(`AliasModelRenderer: no such skin # ${num}\n`);
      num = 0;
    }

    let skin = clmodel.skins[num];

    // Handle skin groups (animated textures)
    if (skin.group) {
      const groupLen = skin.skins.length - 1;
      const fullinterval = skin.skins[groupLen].interval;
      const targettime = time - Math.floor(time / fullinterval) * fullinterval;

      let i = 0;
      for (i = 0; i < groupLen; i++) {
        if (skin.skins[i].interval > targettime) {
          break;
        }
      }
      return skin.skins[i];
    }

    return skin;
  }

  /**
   * Cleanup rendering state after alias models.
   * @param _pass Rendering pass (0=opaque, 1=transparent).
   */

  override cleanupRenderState(_pass = 0): void {
    // Alias models clean up their own state per-entity
    // No shared cleanup needed at this level
  }

  /**
   * Prepare alias model for rendering (build vertex buffers from triangle data).
   * @param model The alias model to prepare.
   * @param isWorldModel Whether this model is the world model.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  override prepareModel(model: BaseModel, isWorldModel = false): void {
    Con.DPrint(`AliasModelRenderer.prepareModel: TODO - implement for ${model.name}\n`);
  }

  /**
   * Free GPU resources for this alias model.
   * @param model The alias model to cleanup.
   */
  override cleanupModel(model: BaseModel): void {
    const aliasModel = model as AliasModel;
    if (aliasModel.cmds) {
      gl.deleteBuffer(aliasModel.cmds);
      aliasModel.cmds = null;
    }
  }
}
