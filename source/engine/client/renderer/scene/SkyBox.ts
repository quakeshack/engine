import { clientRuntimeState } from '../../ClientState.ts';
import ShadowMap from '../lighting/ShadowMap.ts';
import rendererCvars from '../resources/RendererCvars.ts';
import Camera from './Camera.ts';
import type { SkyDrawContext, SkyRenderer } from './Sky.ts';
import Visibility from './Visibility.ts';

/**
 * The sky of the current map: owns the sky renderer the map's model asked for and draws it once the visible
 * leafs say there is sky in view.
 */
class SkyBox {
  static #renderer: SkyRenderer | null = null;

  /**
   * Replaces the sky renderer with the one the world model asks for, after a map change.
   */
  static Make(): void {
    // make sure we always free the old skyrenderer
    if (SkyBox.#renderer) {
      SkyBox.#renderer.shutdown();
    }

    const worldmodel = clientRuntimeState.worldmodel!;
    console.assert(worldmodel !== null, 'worldmodel required');
    SkyBox.#renderer = worldmodel.newSkyRenderer();

    if (!SkyBox.#renderer) {
      return;
    }

    SkyBox.#renderer.init();
  }

  /**
   * Frees the sky renderer.
   */
  static Clear(): void {
    if (!SkyBox.#renderer) {
      return;
    }

    SkyBox.#renderer.shutdown();
    SkyBox.#renderer = null;
  }

  /**
   * Draws the sky when a revealed leaf has sky surfaces.
   */
  static Draw(): void {
    if (!Visibility.skyVisible || !SkyBox.#renderer) {
      return;
    }

    const context: SkyDrawContext = {
      visframecount: Visibility.visframecount,
      vieworg: Camera.refdef.vieworg,
      bloomSkyStrength: rendererCvars.bloomSkyStrength?.value ?? 0.0,
      shadowTexture: ShadowMap.getActiveTopDownTexture(),
      pointShadowTextures: ShadowMap.getActivePointTextures(),
      cullBox: (mins, maxs) => Camera.CullBox(mins, maxs),
    };

    SkyBox.#renderer.render(context);
  }
}

export default SkyBox;
