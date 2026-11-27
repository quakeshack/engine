import type { ConsoleOutput } from '../Services.ts';
import type { ModelTextures } from './ModelLoadContext.ts';
import type { SkeletalMaterial } from './SkeletalModel.ts';

/** Image formats a browser decodes, which a material name may already end with. */
const KNOWN_EXTENSION = /\.(?:png|jpe?g|webp|gif|avif)$/i;

/** Tried in this order for a material name without an image extension. */
const SEARCHED_EXTENSIONS = ['.png', '.jpg'];

/** What a material name resolved to. */
interface FoundImage {
  readonly path: string;
  readonly extension: string;
  readonly texture: NonNullable<SkeletalMaterial['diffuse']>;
}

/** The textures found for one material. */
type MaterialLayers = Pick<SkeletalMaterial, 'diffuse' | 'glow' | 'shirt' | 'pants'>;

/**
 * Finds the textures of the materials of a skeletal model, in a realm that draws.
 *
 * A material is named by the file (`progs/player.mdl.0`, written by the exporter next to the model) and is looked up
 * as that name plus an image extension. Further layers follow the companion naming of DarkPlaces, which FTE reads
 * as well, so assets made for either work here: `<name>_glow`, `<name>_shirt` and `<name>_pants`, in the same
 * format as the base image. They are looked for only when the base image exists, and none of them is required.
 */
export class SkeletalMaterialLoader {
  private constructor() {
    // Static-only helper class.
  }

  /**
   * Fills in the textures of every material. A material whose base image is missing keeps no textures at all and
   * is reported once; the renderer draws its checkerboard for it.
   * @param materials The materials of one model.
   * @param textures Where the images come from.
   * @param con Where the report goes.
   */
  static async load(materials: readonly SkeletalMaterial[], textures: ModelTextures, con: ConsoleOutput): Promise<void> {
    const layers = await Promise.all(materials.map(async (material) => await SkeletalMaterialLoader.#findLayers(material.name, textures, con)));

    materials.forEach((material, index) => {
      const found = layers[index];

      if (found !== null) {
        material.diffuse = found.diffuse;
        material.glow = found.glow;
        material.shirt = found.shirt;
        material.pants = found.pants;
      }
    });
  }

  /**
   * @param name The material name from the model file.
   * @param textures Where the images come from.
   * @param con Where a missing base image is reported.
   * @returns The textures of the material, `null` when its base image does not exist.
   */
  static async #findLayers(name: string, textures: ModelTextures, con: ConsoleOutput): Promise<MaterialLayers | null> {
    const base = await SkeletalMaterialLoader.#findBaseImage(name, textures);

    if (base === null) {
      con.PrintWarning(`SkeletalMaterialLoader: no image for material ${name}\n`);
      return null;
    }

    const stem = base.path.slice(0, base.path.length - base.extension.length);
    const [glow, shirt, pants] = await Promise.all(
      ['_glow', '_shirt', '_pants'].map(async (suffix) => await textures.loadImage(`${stem}${suffix}${base.extension}`)),
    );

    return { diffuse: base.texture, glow, shirt, pants };
  }

  /**
   * @param name The material name from the model file.
   * @param textures Where the images come from.
   * @returns The first image that exists, `null` when none does.
   */
  static async #findBaseImage(name: string, textures: ModelTextures): Promise<FoundImage | null> {
    const extensionMatch = KNOWN_EXTENSION.exec(name);

    if (extensionMatch !== null) {
      const texture = await textures.loadImage(name);
      return texture === null ? null : { path: name, extension: extensionMatch[0], texture };
    }

    for (const extension of SEARCHED_EXTENSIONS) {
      const path = `${name}${extension}`;
      const texture = await textures.loadImage(path);

      if (texture !== null) {
        return { path, extension, texture };
      }
    }

    return null;
  }
}
