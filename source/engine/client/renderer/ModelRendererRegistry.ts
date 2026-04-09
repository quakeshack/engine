import { ModelRenderer } from './ModelRenderer.ts';

/**
 * Registry for model renderers.
 * Maps model types to their corresponding renderer implementations.
 */
export class ModelRendererRegistry {
  readonly #renderers = new Map<number, ModelRenderer>();

  /**
   * Register a renderer for a specific model type.
   */
  register(renderer: ModelRenderer): void {
    const modelType = renderer.getModelType();
    if (this.#renderers.has(modelType)) {
      console.warn(`ModelRendererRegistry: Renderer for type ${modelType} already registered, replacing`);
    }
    this.#renderers.set(modelType, renderer);
  }

  /**
   * Get the renderer for a specific model type.
   * @returns The matching renderer, or null if none is registered.
   */
  getRenderer(modelType: number): ModelRenderer | null {
    return this.#renderers.get(modelType) ?? null;
  }

  /**
   * Check if a renderer is registered for a model type.
   * @returns True when a renderer is registered for the given type.
   */
  hasRenderer(modelType: number): boolean {
    return this.#renderers.has(modelType);
  }

  /**
   * Unregister a renderer for a specific model type.
   * @returns True when a renderer was found and removed.
   */
  unregister(modelType: number): boolean {
    return this.#renderers.delete(modelType);
  }

  /**
   * Clear all registered renderers.
   */
  clear(): void {
    this.#renderers.clear();
  }

  /**
   * Get all registered model types.
   * @returns Array of all registered model type constants.
   */
  getRegisteredTypes(): number[] {
    return Array.from(this.#renderers.keys());
  }
}

/** Singleton instance. */
export const modelRendererRegistry = new ModelRendererRegistry();
