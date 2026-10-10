import type Vector from '../../../../shared/Vector.ts';
import { content } from '../../../../shared/Defs.ts';
import type { BrushModel, Node } from '../../../common/model/BSP.ts';
import { clientRuntimeState } from '../../ClientState.ts';
import rendererCvars from '../resources/RendererCvars.ts';

/**
 * The fog of the scene: the global fog a map asks for in its worldspawn (written into the `r_fog_*` cvars, which
 * `FrameUniforms` uploads), and the color and density of the underwater fog effect while the camera is in a liquid.
 */
class Fog {
  /** RGB fog color used by the underwater fog effect this frame (0-1 range). */
  static underwaterFogColor: [number, number, number] = [0.05, 0.15, 0.2];

  /** Fog density exponent used by the underwater fog effect this frame. */
  static underwaterFogDensity = 0.05;

  /**
   * Sets the global fog from the worldspawn `fog` key of the map that was just loaded, or turns it off.
   */
  static NewMap(): void {
    const worldmodel = clientRuntimeState.worldmodel!;
    console.assert(worldmodel !== null, 'worldmodel must be loaded before InitFog');

    const fogInfo = worldmodel.worldspawnInfo.fog;

    if (!fogInfo) {
      rendererCvars.fog_mode.set(-1);
      return;
    }

    const [exp, r, g, b] = fogInfo.split(/\s+/).map(Number);

    // CR: I took that calculation from Ironwail’s Fog_SetupFrame:
    const ExpAdjustment = 1.20112241; // sqrt(log2(e))
    const SphericalCorrection = 0.85; // compensate higher perceived density with spherical fog
    const DensityScale = ExpAdjustment * SphericalCorrection / 64.0;

    rendererCvars.fog_density.set(exp / DensityScale);
    rendererCvars.fog_color.set(`${r * 255} ${g * 255} ${b * 255}`);
    rendererCvars.fog_mode.set(1);
  }

  /**
   * Picks the color and density of the underwater fog for a camera that is inside a liquid. Run once per frame,
   * and only while the view leaf is underwater.
   * @param worldmodel The current map.
   * @param viewleaf The leaf the camera is in.
   * @param vieworg The camera origin.
   */
  static SelectUnderwaterTint(worldmodel: BrushModel, viewleaf: Node, vieworg: Vector): void {
    // Look up fog tint in priority order:
    //   1. First turbulent chain visible from the viewleaf (direct hit).
    //   2. Nearest spatial anchor built at load time — covers narrow passages
    //      where no surface is in view, and correctly distinguishes between
    //      multiple distinct liquid bodies of the same content type.
    //   3. Hardcoded content-type defaults as a last resort.
    const firstChain = viewleaf.turbulentChains[0];
    const material = firstChain !== undefined
      ? worldmodel.textures[firstChain.texture]
      : undefined;

    let fogTint = material?.fogTint ?? null;

    if (fogTint === null) {
      fogTint = Fog.#nearestLiquidFogTint(worldmodel, vieworg);
    }

    if (fogTint !== null) {
      Fog.underwaterFogColor = fogTint;
    } else if (viewleaf.contents <= content.CONTENT_LAVA) {
      Fog.underwaterFogColor = [0.25, 0.05, 0.0];
    } else if (viewleaf.contents <= content.CONTENT_SLIME) {
      Fog.underwaterFogColor = [0.02, 0.12, 0.0];
    } else {
      Fog.underwaterFogColor = [0.05, 0.15, 0.2];
    }
    Fog.underwaterFogDensity = rendererCvars.underwater_fog_density.value;
  }

  /**
   * Linear nearest-neighbor search over pre-built liquid fog anchors.
   * Returns the fog tint of the closest anchor to `vieworg`, or null if none exist.
   * @returns Fog tint in 0–1 RGB range, or null.
   */
  static #nearestLiquidFogTint(worldmodel: BrushModel, vieworg: Vector): [number, number, number] | null {
    const anchors = worldmodel.liquidFogAnchors;
    if (anchors.length === 0) {
      return null;
    }

    let bestTint = anchors[0].fogTint;
    let bestDist = Number.MAX_VALUE;

    for (let i = 0; i < anchors.length; i++) {
      const c = anchors[i].center;
      const dx = c[0] - vieworg[0];
      const dy = c[1] - vieworg[1];
      const dz = c[2] - vieworg[2];
      const dist = dx * dx + dy * dy + dz * dz;
      if (dist < bestDist) {
        bestDist = dist;
        bestTint = anchors[i].fogTint;
      }
    }

    return bestTint;
  }
}

export default Fog;
