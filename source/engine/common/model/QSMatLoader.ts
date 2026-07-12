import { eventBus, getCommonRegistry, registry } from '../../registry.ts';
import { GLTexture } from '../../client/GL.ts';
import { MaterialFlags, PBRMaterial, QuakeMaterial } from '../../client/renderer/Materials.ts';
import type { BrushModel } from './BSP.ts';

let { COM, Con } = getCommonRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ COM, Con } = getCommonRegistry());
});

interface MaterialDefinition {
  readonly diffuse?: string;
  readonly luminance?: string;
  readonly specular?: string;
  readonly normal?: string;
  readonly flags?: string[];

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
   * Load and apply `.qsmat.json` overrides onto `loadmodel.textures`,
   * replacing matched entries with `PBRMaterial` instances.
   */
  static async load(loadmodel: BrushModel): Promise<void> {
    if (registry.isDedicatedServer) {
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

    const matfiles = await Promise.all(filenames.map((filename) => COM.LoadTextFile(filename)));

    for (let i = 0; i < filenames.length; i++) {
      const filename = filenames[i];
      const matfile = matfiles[i];

      if (!matfile) {
        continue;
      }

      Con.DPrint(`QSMatLoader: loaded material file ${filename}\n`);
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
                Con.DPrint(`QSMatLoader: ${texture.name} has no base texture and no explicit width/height in ${filename}; `
                  + `approximating tiling scale from the diffuse image's own size ${loadedTexture.width}x${loadedTexture.height} `
                  + '(specify width/height in the material entry for correct tiling)\n');
                pbr.width = loadedTexture.width;
                pbr.height = loadedTexture.height;
              }
            }

            Con.DPrint(`QSMatLoader: loaded ${category} texture for ${texture.name} from ${texturePath} (material file ${filename})\n`);
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            Con.PrintError(`QSMatLoader: failed to load ${texturePath} (material file ${filename}): ${errorMessage}\n`);
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

        if (!textures.diffuse && texture instanceof QuakeMaterial && texture.texture !== null) {
          pbr.diffuse = texture.texture; // keep original diffuse as base
        }

        loadmodel.textures[txIndex] = pbr; // replace with PBR material
      }
    }
  }
}
