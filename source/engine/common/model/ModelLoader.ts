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
   */
  abstract getMagicNumbers(): number[];

  /**
   * Returns the file extensions supported by this loader.
   */
  abstract getExtensions(): string[];

  /**
   * Returns a human-readable loader name.
   */
  abstract getName(): string;

  /**
   * Checks whether this loader can handle the given file.
   *
   * The default implementation requires both a matching extension and a
   * matching magic number.
   */
  canLoad(buffer: ArrayBuffer, filename: string): boolean {
    const view = new DataView(buffer);
    const magic = view.getUint32(0, true);
    const extension = filename.substring(filename.lastIndexOf('.')).toLowerCase();

    return this.getExtensions().includes(extension) && this.getMagicNumbers().includes(magic);
  }

  /**
   * Loads a model from the supplied file buffer.
   */
  abstract load(buffer: ArrayBuffer, name: string): Promise<BaseModel>;
}
