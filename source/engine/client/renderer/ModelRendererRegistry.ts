import type { BaseModel } from '../../common/model/BaseModel.ts';
import { ModelRenderer } from './ModelRenderer.ts';

/**
 * Registry for model renderers.
 * Maps model types to their corresponding renderer implementations.
 */
export class ModelRendererRegistry {
  readonly #renderers = new Map<typeof BaseModel, ModelRenderer>();

  /**
   * Register a renderer for a specific model class.
   */
  register(renderer: ModelRenderer): void {
    const modelClass = renderer.getModelClass();

    console.assert(modelClass, 'ModelRenderer must specify a model class');
    console.assert(!this.#renderers.has(modelClass), `ModelRenderer for class ${modelClass.name} is already registered, overwriting`);

    this.#renderers.set(modelClass, renderer);
  }

  /**
   * Get the renderer for a specific model class.
   * @returns The matching renderer, or null if none is registered.
   */
  getRendererForModelClass(modelClass: typeof BaseModel): ModelRenderer | null {
    return this.#renderers.get(modelClass) ?? null;
  }

  /**
   * Get the renderer for a concrete model instance.
   * Supports subclasses by falling back to an `instanceof` match.
   * @returns The matching renderer, or null if none is registered.
   */
  getRendererForModel(model: BaseModel): ModelRenderer | null {
    const directRenderer = this.#renderers.get(model.constructor as typeof BaseModel);

    if (directRenderer) {
      return directRenderer;
    }

    return null;
  }

  /**
   * Check if a renderer is registered for a model class.
   * @returns True when a renderer is registered for the given class.
   */
  hasRendererForModelClass(modelClass: typeof BaseModel): boolean {
    return this.#renderers.has(modelClass);
  }

  /**
   * Unregister a renderer for a specific model class.
   * @returns True when a renderer was found and removed.
   */
  unregisterForModelClass(modelClass: typeof BaseModel): boolean {
    return this.#renderers.delete(modelClass);
  }

  /**
   * Clear all registered renderers.
   */
  clear(): void {
    this.#renderers.clear();
  }

  /**
   * Get all registered model classes.
   * @returns Array of all registered model constructors.
   */
  getRegisteredModelClasses(): (typeof BaseModel)[] {
    return Array.from(this.#renderers.keys());
  }
}

/** Singleton instance. */
export const modelRendererRegistry = new ModelRendererRegistry();
