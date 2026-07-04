import Vector from '../../../shared/Vector.ts';
import { ModelRenderer, type ShadowRenderContext } from './ModelRenderer.ts';
import { getEntityBloomEmissiveScale } from './BloomEffect.ts';
import { eventBus, getClientRegistry } from '../../registry.ts';
import GL from '../GL.ts';
import W from '../../common/W.ts';
import { effect } from '../../../shared/Defs.ts';
import { AliasModel, type AliasSingleFrame, type AliasGroupedFrameEntry, type AliasSingleSkin, type AliasGroupedSkinEntry } from '../../common/model/AliasModel.ts';
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
   * Get the model class this renderer handles.
   * @returns AliasModel constructor.
   */
  override getModelClass(): typeof AliasModel {
    return AliasModel;
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

    // Bind top-down shadow map
    if (program!.tShadowMap !== undefined && R.shadow_texture) {
      GL.Bind(program!.tShadowMap, R.shadow_texture);
    }

    // Bind point light cube shadow maps
    if (program!.tPointShadowMap0 !== undefined && R.point_shadow_textures?.[0]) {
      GL.BindCube(program!.tPointShadowMap0, R.point_shadow_textures[0]);
    }
    if (program!.tPointShadowMap1 !== undefined && R.point_shadow_textures?.[1]) {
      GL.BindCube(program!.tPointShadowMap1, R.point_shadow_textures[1]);
    }
    if (program!.tPointShadowMap2 !== undefined && R.point_shadow_textures?.[2]) {
      GL.BindCube(program!.tPointShadowMap2, R.point_shadow_textures[2]);
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

  override renderShadow(model: BaseModel, entity: ClientEdict, ctx: ShadowRenderContext): void {
    const clmodel = model as AliasModel;
    if (!clmodel.cmds) {
      return;
    }
    const program = GL.UseProgram(ctx.isPointLight ? 'shadow-alias-point' : 'shadow-alias')!;

    gl.uniform3fv(program.uOrigin!, entity.lerp.origin);
    gl.uniformMatrix3fv(program.uAngles!, false, entity.lerp.angles.toRotationMatrix());
    gl.uniformMatrix4fv(program.uLightSpaceMatrix!, false, ctx.lightSpaceMatrix);
    gl.uniform1f(program.uCasterFade!, ctx.casterFade);

    const { frameA, frameB, targettime } = AliasModelRenderer._selectFrames(clmodel, entity);

    gl.uniform1f(program.uInterpolation!, R.interpolation.value && (entity.effects & effect.EF_MUZZLEFLASH) === 0 ? Math.min(1, Math.max(0, targettime)) : 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, clmodel.cmds as WebGLBuffer);
    gl.enableVertexAttribArray(program.aPositionA!.location as number);
    gl.enableVertexAttribArray(program.aPositionB!.location as number);
    gl.vertexAttribPointer(program.aPositionA!.location as number, 3, gl.FLOAT, false, 24, frameA.cmdofs!);
    gl.vertexAttribPointer(program.aPositionB!.location as number, 3, gl.FLOAT, false, 24, frameB.cmdofs!);

    if (program.aNormalA) {
      gl.enableVertexAttribArray(program.aNormalA!.location as number);
      gl.enableVertexAttribArray(program.aNormalB!.location as number);
      gl.vertexAttribPointer(program.aNormalA!.location as number, 3, gl.FLOAT, false, 24, frameA.cmdofs! + 12);
      gl.vertexAttribPointer(program.aNormalB!.location as number, 3, gl.FLOAT, false, 24, frameB.cmdofs! + 12);
      gl.uniform3fv(program.uLightPos!, ctx.pointLightOrigin);
      gl.uniform1f(program.uNormalBias!, ctx.pointNormalBias);
    }

    gl.drawArrays(gl.TRIANGLES, 0, clmodel._num_tris * 3);

    gl.disableVertexAttribArray(program.aPositionA!.location as number);
    gl.disableVertexAttribArray(program.aPositionB!.location as number);
    if (program.aNormalA) {
      gl.disableVertexAttribArray(program.aNormalA!.location as number);
      gl.disableVertexAttribArray(program.aNormalB!.location as number);
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
      const previous = clmodel.frames[previousFrame];
      const next = clmodel.frames[nextFrame];
      console.assert(!previous.group, 'alias lerp previous frame must be a single frame');
      console.assert(!next.group, 'alias lerp next frame must be a single frame');

      if (previous.group) {
        frameA = previous.frames[0];
      } else {
        frameA = previous as AliasSingleFrame;
      }

      if (next.group) {
        frameB = next.frames[0];
      } else {
        frameB = next as AliasSingleFrame;
      }

      targettime = f;
    } else {
      console.assert(!frameGroup.group, 'alias static frame must be a single frame');
      const staticFrame = frameGroup as AliasSingleFrame;
      frameA = staticFrame;
      frameB = staticFrame;
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

    const skin = clmodel.skins[num];

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

    return skin as AliasSingleSkin;
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
