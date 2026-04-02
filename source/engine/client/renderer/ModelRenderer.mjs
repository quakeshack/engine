import { NotImplementedError } from '../../common/Errors.ts';

/**
 * Abstract base class for model renderers.
 * Implements the Strategy pattern for polymorphic model rendering.
 * Each model type (Brush, Alias, Sprite) has its own renderer implementation.
 *
 * Note: Uses global `gl` from registry rather than passing as parameter.
 */
export class ModelRenderer {
  /**
   * Get the model type this renderer handles
   * @returns {number} Model type constant (Mod.type.brush, Mod.type.alias, Mod.type.sprite)
   */
  getModelType() {
    throw new NotImplementedError('ModelRenderer.getModelType must be implemented');
    // eslint-disable-next-line no-unreachable
    return -1;
  }

  /**
   * Setup rendering state for this model type.
   * Called once before rendering multiple entities of the same type.
   * @param {number} [_pass] Rendering pass (0=opaque, 1=transparent, etc.)
   */
  // eslint-disable-next-line no-unused-vars
  setupRenderState(_pass = 0) {
    throw new NotImplementedError('ModelRenderer.setupRenderState must be implemented');
  }

  /**
   * Whether this model/entity pair should contribute to the opaque pass.
   * Renderers can override this when transparency is entity- or material-driven.
   * @param {import('../../common/model/BaseModel.ts').BaseModel} _model The model to evaluate
   * @param {import('../ClientEntities.mjs').ClientEdict} _entity The entity to evaluate
   * @returns {boolean} True when the pair should render during the opaque pass
   */
  // eslint-disable-next-line no-unused-vars
  rendersOpaquePass(_model, _entity) {
    return true;
  }

  /**
   * Whether this model/entity pair should contribute to the sorted transparent pass.
   * Sprites are handled by their dedicated pass and should normally return false here.
   * @param {import('../../common/model/BaseModel.ts').BaseModel} _model The model to evaluate
   * @param {import('../ClientEntities.mjs').ClientEdict} _entity The entity to evaluate
   * @returns {boolean} True when the pair should render during the sorted transparent pass
   */
  // eslint-disable-next-line no-unused-vars
  rendersTransparentPass(_model, _entity) {
    return false;
  }

  /**
   * Render a single entity with this model type.
   * @param {import('../../common/model/BaseModel.ts').BaseModel} _model The model to render
   * @param {import('../ClientEntities.mjs').ClientEdict} _entity The entity being rendered
   * @param {number} [_pass] Rendering pass (0=opaque, 1=transparent, etc.)
   */
  // eslint-disable-next-line no-unused-vars
  render(_model, _entity, _pass = 0) {
    throw new NotImplementedError('ModelRenderer.render must be implemented');
  }

  /**
   * Cleanup rendering state after rendering all entities of this type.
   * Called once after rendering multiple entities of the same type.
   * @param {number} [_pass] Rendering pass (0=opaque, 1=transparent, etc.)
   */
  // eslint-disable-next-line no-unused-vars
  cleanupRenderState(_pass = 0) {
    throw new NotImplementedError('ModelRenderer.cleanupRenderState must be implemented');
  }

  /**
   * Prepare model for rendering (build display lists, upload to GPU, etc.).
   * Called when model is first loaded or needs rebuilding.
   * Uses global `gl` from registry.
   * @param {import('../../common/model/BaseModel.ts').BaseModel} _model The model to prepare
   * @param {boolean} isWorldModel Whether this model is the world model
   */
  // eslint-disable-next-line no-unused-vars
  prepareModel(_model, isWorldModel = false) {
    throw new NotImplementedError('ModelRenderer.prepareModel must be implemented');
  }

  /**
   * Free GPU resources for this model.
   * Called when model is unloaded or needs cleanup.
   * Uses global `gl` from registry.
   * @param {import('../../common/model/BaseModel.ts').BaseModel} _model The model to cleanup
   */
  // eslint-disable-next-line no-unused-vars
  cleanupModel(_model) {
    // Default implementation: do nothing (override if needed)
  }
}
