import type { BaseModel } from './BaseModel.ts';

/**
 * Abstract base class for model format loaders.
 *
 * Each model format provides magic-number detection and a loader that returns
 * a populated model instance.
 */
export abstract class ModelLoader {
  /**
   * Returns the magic numbers that identify this format.
   * Magic numbers are read from the first four bytes of the file.
   * @returns The magic numbers recognized by this loader.
   */
  abstract getMagicNumbers(): number[];

  /**
   * Returns the file extensions supported by this loader.
   * @returns The supported file extensions.
   */
  abstract getExtensions(): string[];

  /**
   * Returns a human-readable loader name.
   * @returns The loader display name.
   */
  abstract getName(): string;

  /**
   * Checks whether this loader can handle the given file.
   *
   * The default implementation requires both a matching extension and a
   * matching magic number.
   * @returns True when the loader can handle the supplied file.
   */
  canLoad(buffer: ArrayBuffer, filename: string): boolean {
    const view = new DataView(buffer);
    const magic = view.getUint32(0, true);
    const extension = filename.substring(filename.lastIndexOf('.')).toLowerCase();

    return this.getExtensions().includes(extension) && this.getMagicNumbers().includes(magic);
  }

  /**
   * Loads a model from the supplied file buffer.
   * @returns A promise resolving to the loaded model.
   */
  abstract load(buffer: ArrayBuffer, name: string): Promise<BaseModel>;
}
