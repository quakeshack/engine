import { eventBus } from '../../../common/EventBus.ts';
import type { ClientEdict } from '../../ClientEntities.ts';
import { clientRuntimeState } from '../../ClientState.ts';
import GL, { type GLProgramInfo, type GLTexture } from '../../GL.ts';
import DefaultTextures from '../resources/DefaultTextures.ts';
import Interpolation from '../scene/Interpolation.ts';
import RenderStats from '../scene/RenderStats.ts';
import { MaterialFlags, NoTextureMaterial, PBRMaterial, QuakeMaterial, type BaseMaterial } from './Materials.ts';

let gl: WebGL2RenderingContext = null!;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null!;
});

/**
 * Resolve the luminance texture for a material draw.
 * Materials flagged MF_FULLBRIGHT fall back to their diffuse texture when they
 * do not provide a separate luminance map.
 * @param flags Material flags.
 * @param luminanceTexture Explicit luminance texture.
 * @param diffuseTexture Active diffuse texture.
 * @param fallbackTexture Renderer fallback texture.
 * @returns Luminance texture to bind for the draw.
 */
export function resolveMaterialLuminanceTexture(flags: number, luminanceTexture: GLTexture | null, diffuseTexture: GLTexture | null, fallbackTexture: GLTexture): GLTexture {
  if (luminanceTexture && luminanceTexture !== fallbackTexture) {
    return luminanceTexture;
  }

  if ((flags & MaterialFlags.MF_FULLBRIGHT) !== 0 && diffuseTexture !== null) {
    return diffuseTexture;
  }

  return fallbackTexture;
}

/**
 * Prepares a material for a draw and binds its textures to the sampler units of a program. The materials are data
 * (see `Materials.ts`) so that the model loaders can build them where nothing is drawn; everything that needs the
 * renderer, the client clock or a GL context happens here, in the model renderers' realm.
 */
class MaterialBinder {
  /**
   * Resolves what a draw of the material shows: the alpha (a map can make its liquids translucent through
   * worldspawn keys) and, for a material with animation frames, the frame.
   * @param material The material about to be drawn.
   * @param clientEdict The entity it is drawn for, `null` for none.
   */
  static Emit(material: BaseMaterial, clientEdict: ClientEdict | null = null): void {
    material.currentAlpha = MaterialBinder.#resolveAlpha(material, clientEdict);

    if (material instanceof QuakeMaterial) {
      material.selectFrame(clientEdict !== null ? clientEdict.frame : 0, clientRuntimeState.time);
    }
  }

  /**
   * Binds a material's textures and lighting mode for the current draw. When the model being drawn carries BSPX
   * `LIGHTINGDIR` data, per-pixel Lambertian shading against the deluxemap direction is enabled using a flat
   * normal map, so plain (non-`.qsmat.json`) surfaces benefit from the baked directional lighting the same way PBR
   * materials do.
   * @param material The material to bind.
   * @param program The active shader program.
   * @param hasDeluxemap Whether the model has a deluxemap.
   */
  static Bind(material: BaseMaterial, program: GLProgramInfo, hasDeluxemap: boolean = false): void {
    if (material instanceof PBRMaterial) {
      MaterialBinder.#bindPBR(material, program);
    } else if (material instanceof QuakeMaterial) {
      MaterialBinder.#bindQuake(material, program, hasDeluxemap);
    } else if (material instanceof NoTextureMaterial) {
      DefaultTextures.notexture.bind(0);
    }
  }

  /**
   * Resolve the effective alpha for this material on the current draw.
   * @returns Alpha in the 0..1 range.
   */
  static #resolveAlpha(material: BaseMaterial, clientEdict: ClientEdict | null): number {
    if ((material.flags & MaterialFlags.MF_TURBULENT) === 0 || clientEdict === null) {
      return 1.0;
    }

    const worldspawn = clientRuntimeState.clientEntities.getEntity(0);
    if (clientEdict !== worldspawn) {
      return 1.0;
    }

    const worldspawnInfo = clientRuntimeState.worldmodel?.worldspawnInfo;
    if (!worldspawnInfo) {
      return 1.0;
    }

    const alphaKeys = material.getLiquidAlphaKeys();
    for (let i = 0; i < alphaKeys.length; i++) {
      const rawValue = worldspawnInfo[alphaKeys[i]];
      if (rawValue === undefined) {
        continue;
      }

      const parsedAlpha = Number.parseFloat(rawValue);
      if (Number.isFinite(parsedAlpha)) {
        return Math.max(0.0, Math.min(parsedAlpha, 1.0));
      }
    }

    return 1.0;
  }

  static #bindQuake(material: QuakeMaterial, program: GLProgramInfo, hasDeluxemap: boolean): void {
    const currentTexture = material.currentTexture ?? DefaultTextures.notexture;
    const nextTexture = material.nextTexture ?? currentTexture;
    const luminanceTexture = resolveMaterialLuminanceTexture(material.flags, material.currentLuminanceTexture, currentTexture, DefaultTextures.blacktexture);

    gl.uniform1i(program.uPerformDotLighting!, hasDeluxemap ? 1 : 0);
    MaterialBinder.#bindInterpolation(program);
    MaterialBinder.#bindPrimaryTextures(program, currentTexture, nextTexture);
    MaterialBinder.#bindLuminance(program, luminanceTexture);

    if (!hasDeluxemap) {
      return;
    }

    if (program.tNormal !== undefined) {
      DefaultTextures.flatnormalmap.bind(program.tNormal!);
      RenderStats.c_brush_texture_binds++;
    }

    if (program.tSpecular !== undefined) {
      DefaultTextures.blacktexture.bind(program.tSpecular!);
      RenderStats.c_brush_texture_binds++;
    }
  }

  static #bindPBR(material: PBRMaterial, program: GLProgramInfo): void {
    const currentTexture = material.diffuse ?? DefaultTextures.notexture;
    const luminanceTexture = resolveMaterialLuminanceTexture(material.flags, material.luminance, currentTexture, DefaultTextures.blacktexture);

    if (program.uPerformDotLighting !== undefined) {
      gl.uniform1i(program.uPerformDotLighting!, 1);
    }

    MaterialBinder.#bindInterpolation(program);
    MaterialBinder.#bindPrimaryTextures(program, currentTexture, currentTexture);

    if (program.tSpecular !== undefined) {
      (material.specular ?? DefaultTextures.blacktexture).bind(program.tSpecular!);
      RenderStats.c_brush_texture_binds++;
    }

    if (program.tNormal !== undefined) {
      (material.normal ?? DefaultTextures.flatnormalmap).bind(program.tNormal!);
      RenderStats.c_brush_texture_binds++;
    }

    MaterialBinder.#bindLuminance(program, luminanceTexture);
  }

  static #bindInterpolation(program: GLProgramInfo): void {
    if (program.uInterpolation !== undefined) {
      gl.uniform1f(program.uInterpolation!, Interpolation.Texture());
    }
  }

  static #bindLuminance(program: GLProgramInfo, luminanceTexture: GLTexture): void {
    if (program.tLuminance !== undefined) {
      luminanceTexture.bind(program.tLuminance!);
      RenderStats.c_brush_texture_binds++;
    }
  }

  static #bindPrimaryTextures(program: GLProgramInfo, currentTexture: GLTexture, nextTexture: GLTexture): void {
    if (program.tTextureA !== undefined && program.tTextureB !== undefined) {
      currentTexture.bind(program.tTextureA!);
      nextTexture.bind(program.tTextureB!);
      RenderStats.c_brush_texture_binds += 2;
    }

    if (program.tTexture !== undefined) {
      currentTexture.bind(program.tTexture!);
      RenderStats.c_brush_texture_binds++;
    }
  }
}

export default MaterialBinder;
