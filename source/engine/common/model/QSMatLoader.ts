import { GLTexture } from '../../client/GL.ts';
import { type BaseMaterial, MaterialFlags, PBRMaterial, QuakeMaterial } from '../../client/renderer/models/Materials.ts';
import type { BrushModel } from './BSP.ts';
import type { ModelLoadContext } from './ModelLoadContext.ts';

export interface MaterialDefinition {
  readonly diffuse?: string;
  readonly luminance?: string;
  readonly specular?: string;
  readonly normal?: string;
  readonly flags?: string[];

  /**
   * How opaque the surface is, 0..1. Anything below 1 makes a surface that is not a liquid `MF_TRANSPARENT`. On top
   * of the diffuse image's alpha channel; a liquid takes it unless the map sets its own alpha key on the worldspawn.
   */
  readonly alpha?: number;

  /** How strongly the surface refracts what is behind it, 0 or more, and it makes the material `MF_REFRACT`. */
  readonly refraction?: number;

  /**
   * Optional explicit texel-space tiling dimensions, overriding whatever the
   * base texture (or the loaded diffuse image) would otherwise supply. Needed
   * for formats such as BSP38 that have no base texture to derive a size
   * from, and useful whenever a replacement diffuse image isn't pixel-for-
   * pixel identical to the original compiled texture's size.
   */
  readonly width?: number;
  readonly height?: number;
}

interface MaterialFile {
  readonly version: number;
  readonly materials: Record<string, MaterialDefinition>;
}

type MaterialTextureCategory = 'luminance' | 'diffuse' | 'specular' | 'normal';

/**
 * Loads `.qsmat.json` PBR material overrides declared via a map's worldspawn
 * `_qs_mat` key. Shared by every BSP loader (BSP29, BSP2, BSP38): this only
 * touches `loadmodel.textures` (matched by `.name`) and
 * `loadmodel.worldspawnInfo._qs_mat`, with no format-specific logic, so it
 * must not be duplicated per loader.
 */
export class QSMatLoader {
  private constructor() {
    // Static-only helper class.
  }

  /**
   * Applies the `alpha` and `refraction` of a material entry. A number that is missing or not finite is skipped, the
   * rest is clamped: alpha to 0..1, refraction to 0 or more.
   * @param material The material built from the entry.
   * @param definition The entry.
   * @param inheritedAlpha The alpha the replaced material already had (a BSP loader sets one for the Quake 2
   * translucency flags), used when the entry has none.
   */
  static applySurfaceParameters(material: BaseMaterial, definition: MaterialDefinition, inheritedAlpha: number | null): void {
    material.alpha = Number.isFinite(definition.alpha) ? Math.max(0.0, Math.min(definition.alpha!, 1.0)) : inheritedAlpha;

    if (material.alpha !== null && material.alpha < 1.0 && (material.flags & MaterialFlags.MF_TURBULENT) === 0) {
      material.flags |= MaterialFlags.MF_TRANSPARENT;
    }

    if (Number.isFinite(definition.refraction)) {
      material.refraction = Math.max(0.0, definition.refraction!);
      material.flags |= MaterialFlags.MF_REFRACT;
    }
  }

  /**
   * Load and apply `.qsmat.json` overrides onto `loadmodel.textures`,
   * replacing matched entries with `PBRMaterial` instances.
   */
  static async load(loadmodel: BrushModel, context: ModelLoadContext): Promise<void> {
    if (!context.loadRenderData) {
      return;
    }

    const filenames: string[] = [];

    for (const qsMat of (loadmodel.worldspawnInfo._qs_mat?.split(/;\s*/) ?? [])) {
      const filename = qsMat.trim();

      if (filename === '') {
        continue;
      }

      filenames.push(filename);
    }

    const matfiles = await Promise.all(filenames.map((filename) => context.files.LoadTextFile(filename)));

    for (let i = 0; i < filenames.length; i++) {
      const filename = filenames[i];
      const matfile = matfiles[i];

      if (!matfile) {
        continue;
      }

      context.con.DPrint(`QSMatLoader: loaded material file ${filename}\n`);
      const materialData = JSON.parse(matfile) as MaterialFile;
      console.assert(materialData.version === 1);

      for (const [txName, textures] of Object.entries(materialData.materials)) {
        const textureEntry = Array.from(loadmodel.textures.entries()).find(([, t]) => t.name === txName);

        if (!textureEntry) {
          continue;
        }

        const [txIndex, texture] = textureEntry;

        // Explicit width/height always win. Otherwise fall back to the base
        // texture's own size (correct for BSP29/BSP2, where that size comes
        // from the decoded miptex); a base-less texture (e.g. BSP38 before
        // native .wal loading exists) falls back further to the loaded
        // diffuse image's own pixel size below, which is only an
        // approximation of the map's true compiled texel scale.
        const pbr = new PBRMaterial(texture.name, textures.width ?? texture.width, textures.height ?? texture.height);

        const materialTextureCategories: MaterialTextureCategory[] = ['luminance', 'diffuse', 'specular', 'normal'];

        for (const category of materialTextureCategories) {
          const texturePath = textures[category];

          if (!texturePath) {
            continue;
          }

          try {
            const loadedTexture = await GLTexture.FromImageFile(texturePath);

            if (loadedTexture !== null) {
              pbr[category] = loadedTexture;

              const hasBaseTextureSize = texture instanceof QuakeMaterial && texture.texture !== null;

              if (category === 'diffuse' && textures.width === undefined && textures.height === undefined && !hasBaseTextureSize) {
                context.con.DPrint(`QSMatLoader: ${texture.name} has no base texture and no explicit width/height in ${filename}; `
                  + `approximating tiling scale from the diffuse image's own size ${loadedTexture.width}x${loadedTexture.height} `
                  + '(specify width/height in the material entry for correct tiling)\n');
                pbr.width = loadedTexture.width;
                pbr.height = loadedTexture.height;
              }
            }

            context.con.DPrint(`QSMatLoader: loaded ${category} texture for ${texture.name} from ${texturePath} (material file ${filename})\n`);
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            context.con.PrintError(`QSMatLoader: failed to load ${texturePath} (material file ${filename}): ${errorMessage}\n`);
          }
        }

        if (textures.flags) {
          for (const flagName of textures.flags) {
            const flagValue = MaterialFlags[flagName as keyof typeof MaterialFlags];
            console.assert(typeof flagValue === 'number', `QSMatLoader: unknown material flag ${flagName} in ${loadmodel.name} (material file ${filename})`);
            if (typeof flagValue === 'number') {
              pbr.flags |= flagValue;
            }
          }
        }

        QSMatLoader.applySurfaceParameters(pbr, textures, texture.alpha);

        if (!textures.diffuse && texture instanceof QuakeMaterial && texture.texture !== null) {
          pbr.diffuse = texture.texture; // keep original diffuse as base
        }

        loadmodel.textures[txIndex] = pbr; // replace with PBR material
      }
    }
  }
}
