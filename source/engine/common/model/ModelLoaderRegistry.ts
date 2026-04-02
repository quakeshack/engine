import { NotImplementedError } from '../Errors.ts';
import type { BaseModel } from './BaseModel.ts';
import type { ModelLoader } from './ModelLoader.ts';

/**
 * Registry for managing model format loaders.
 *
 * Loaders are checked in registration order so more specific formats can win
 * before broader fallbacks.
 */
export class ModelLoaderRegistry {
  readonly loaders: ModelLoader[] = [];

  /**
   * Registers a model loader.
   */
  register(loader: ModelLoader): void {
    this.loaders.push(loader);
  }

  /**
   * Finds a loader that can handle the given file.
   */
  findLoader(buffer: ArrayBuffer, filename: string): ModelLoader | null {
    for (const loader of this.loaders) {
      if (loader.canLoad(buffer, filename)) {
        return loader;
      }
    }

    return null;
  }

  /**
   * Loads a model using the first compatible registered loader.
   */
  async load(buffer: ArrayBuffer, name: string): Promise<BaseModel> {
    const loader = this.findLoader(buffer, name);

    if (loader === null) {
      throw new NotImplementedError(`No loader found for model format: ${name}`);
    }

    return await loader.load(buffer, name);
  }

  /**
   * Clears the registry.
   */
  clear(): void {
    this.loaders.length = 0;
  }
}
