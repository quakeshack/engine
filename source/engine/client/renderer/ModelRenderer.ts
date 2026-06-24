import { NotImplementedError } from '../../common/Errors.ts';
import { BaseModel } from '../../common/model/BaseModel.ts';
import type { ClientEdict } from '../ClientEntities.ts';

/**
 * Per-entity context passed to renderShadow, carrying the shadow-pass uniforms needed
 * to render one entity into the active shadow map.
 */
export interface ShadowRenderContext {
  readonly lightSpaceMatrix: Float64Array;
  readonly casterFade: number;
  readonly isPointLight: boolean;
  /** Point light world-space origin — used only when the shadow program has normal-bias support. */
  readonly pointLightOrigin: Float32Array;
  /** Normal-offset bias value for point light shadow shaders. */
  readonly pointNormalBias: number;
}

/**
 * Abstract base class for model renderers.
 * Implements the Strategy pattern for polymorphic model rendering.
 * Each model type (Brush, Alias, Sprite) has its own renderer implementation.
 *
 * Note: Uses global `gl` from registry rather than passing as parameter.
 */
export class ModelRenderer {
  /**
   * Returns the model class this renderer handles.
   * @returns The model constructor used for registry dispatch.
   */
  getModelClass(): typeof BaseModel {
    throw new NotImplementedError('ModelRenderer.getModelClass must be implemented');
    // eslint-disable-next-line no-unreachable
    return BaseModel;
  }

  /**
   * Setup rendering state for this model type.
   * Called once before rendering multiple entities of the same type.
   */

  setupRenderState(_pass = 0): void {
    throw new NotImplementedError('ModelRenderer.setupRenderState must be implemented');
  }

  /**
   * Whether this model/entity pair should contribute to the opaque pass.
   * Renderers can override this when transparency is entity- or material-driven.
   */

  rendersOpaquePass(_model: BaseModel, _entity: ClientEdict): boolean {
    return true;
  }

  /**
   * Whether this model/entity pair should contribute to the sorted transparent pass.
   * Return true for model/entity pairs that should be depth-sorted and blended.
   */

  rendersTransparentPass(_model: BaseModel, _entity: ClientEdict): boolean {
    return false;
  }

  /**
   * Render a single entity with this model type.
   */

  render(_model: BaseModel, _entity: ClientEdict, _pass = 0): void {
    throw new NotImplementedError('ModelRenderer.render must be implemented');
  }

  /**
   * Render a single entity's shadow into the active shadow map.
   * Default no-op — sprites and other non-occluding types cast no shadow.
   */
  renderShadow(_model: BaseModel, _entity: ClientEdict, _ctx: ShadowRenderContext): void {}

  /**
   * Cleanup rendering state after rendering all entities of this type.
   * Called once after rendering multiple entities of the same type.
   */

  cleanupRenderState(_pass = 0): void {
    throw new NotImplementedError('ModelRenderer.cleanupRenderState must be implemented');
  }

  /**
   * Prepare model for rendering (build display lists, upload to GPU, etc.).
   * Called when model is first loaded or needs rebuilding.
   * Uses global `gl` from registry.
   */

  prepareModel(_model: BaseModel, _isWorldModel = false): void {
    throw new NotImplementedError('ModelRenderer.prepareModel must be implemented');
  }

  /**
   * Free GPU resources for this model.
   * Called when model is unloaded or needs cleanup.
   * Uses global `gl` from registry.
   */

  cleanupModel(_model: BaseModel): void {
    // Default implementation: do nothing (override if needed)
  }
}
