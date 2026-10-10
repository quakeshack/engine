import Vector from '../../../../shared/Vector.ts';
import { effect } from '../../../../shared/Defs.ts';
import * as Def from '../../../common/Def.ts';
import Host from '../../../common/Host.ts';
import { clientRuntimeState } from '../../ClientState.ts';
import type { ClientEdict } from '../../ClientEntities.ts';
import V from '../../V.ts';
import LightSampler from './LightSampler.ts';

/** Ambient light, shade light, nearest light origin, dynamic shade light and dynamic light origin of an entity. */
export type EntityLightValues = [Vector, Vector, Vector, Vector, Vector];

/**
 * The lighting of a rendered entity: the baked light at its position, the dynamic lights that reach it, the
 * minimum brightness rules, and the smoothing that hides lightmap boundaries.
 */
export class EntityLighting {
  /**
   * Alias models in Quake sample static light slightly above their origin so
   * monsters are lit from torso height rather than foot height.
   * @returns World position used for static light sampling.
   */
  static GetEntityLightSamplePoint(entity: ClientEdict): Vector {
    const samplePoint = entity.lerp.origin.copy();

    if (entity.model !== null) {
      // samplePoint[2] -= entity.mins[2] + 24.0; // effectively +24.0u on alias models
      // CR: fun, that makes the boss in E1M7 pitch black
    }

    // console.log(`Sampling light for entity ${entity.num} at ${samplePoint}`, entity.model, entity.mins, entity.maxs);

    return samplePoint;
  }

  /**
   * Calculates static and dynamic lighting terms for a rendered entity.
   * @returns Ambient light, shade light, nearest light origin, dynamic shade light, and dynamic light origin.
   */
  static CalculateLightValues(e: ClientEdict): EntityLightValues {
    const [ambientlight, lightOrigin] = LightSampler.LightPoint(EntityLighting.GetEntityLightSamplePoint(e));
    const shadelight = ambientlight.copy();

    // never have a pitch black view model
    if (e === clientRuntimeState.viewent && ambientlight.average() < 24.0) {
      if (ambientlight.average() === 0) {
        ambientlight.setTo(1.0, 1.0, 1.0); // no color, set to white
      }
      ambientlight.multiply(24.0);
      shadelight.set(ambientlight);
    }

    const dynamicShadeLight = new Vector(0.0, 0.0, 0.0);
    const dynamicLightOrigin = new Vector(0.0, 0.0, 0.0);
    let maxAdd = 0.0;

    // add dynamic lights
    for (let i = 0; i < Def.limits.dlights; i++) {
      const dl = clientRuntimeState.clientEntities.dlights[i];

      if (dl.isFree()) {
        continue;
      }

      const add = dl.radius - e.lerp.origin.distanceTo(dl.origin);

      if (add > 0.0) {
        const color = dl.color.copy();
        const vadd = color.multiply(add);
        dynamicShadeLight.add(vadd);

        if (add > maxAdd) {
          maxAdd = add;
          dynamicLightOrigin.set(dl.origin);
        }
      }
    }

    // do not overbright
    const alavg = ambientlight.greatest();
    if (alavg > 128.0) {
      ambientlight.multiply(128.0 / alavg);
    }

    const slavg = shadelight.greatest();
    if (slavg > 128.0) {
      shadelight.multiply(128.0 / slavg);
    }

    const dlavg = dynamicShadeLight.greatest();
    if (dlavg > 128.0) {
      dynamicShadeLight.multiply(128.0 / dlavg);
    }

    if (e.effects & (effect.EF_FULLBRIGHT | effect.EF_MUZZLEFLASH)) {
      ambientlight.setTo(255.0, 255.0, 255.0);
      shadelight.set(ambientlight);
    } else if ((e.num >= 1 && e.num <= clientRuntimeState.maxclients && shadelight.greatest() < 8.0) || (e.effects & effect.EF_MINLIGHT)) {
      // never let players go totally dark either
      if (ambientlight.average() === 0) {
        ambientlight.setTo(1.0, 1.0, 1.0); // no color, set to white
      }
      ambientlight.multiply(8.0);
      shadelight[0] = Math.max(shadelight[0], ambientlight[0]);
      shadelight[1] = Math.max(shadelight[1], ambientlight[1]);
      shadelight[2] = Math.max(shadelight[2], ambientlight[2]);
    }

    ambientlight.multiply(0.0078125); // / 128.0
    shadelight.multiply(0.0078125); // / 128.0
    dynamicShadeLight.multiply(0.0078125);

    return EntityLighting.SmoothLightValues(e, ambientlight, shadelight, lightOrigin, dynamicShadeLight, dynamicLightOrigin);
  }

  /**
   * How quickly smoothed lighting eases towards a freshly sampled value; see
   * `V.SmoothValue` for the exponential-decay formula this drives. Chosen to
   * be slow enough to hide lightmap-boundary popping but still track normal
   * movement speeds without feeling laggy.
   */
  static readonly #lightSmoothingSharpness = 10.0;

  /**
   * A freshly sampled light origin this far from the entity's previously
   * smoothed origin is treated as a teleport or edict-slot reuse (a
   * `ClientEdict` is recycled by number for unrelated game objects) rather
   * than normal movement, and snaps instead of easing in.
   */
  static readonly #lightTeleportDistance = 500.0;

  /**
   * Blends freshly sampled lighting terms into the entity's persisted
   * smoothed state, easing across lightmap boundaries instead of snapping.
   * Snaps immediately on first sample or when the light origin jumps far
   * enough to indicate a teleport or a recycled edict slot.
   * @returns The entity's smoothed ambient/shade/dynamic lighting terms.
   */
  static SmoothLightValues(e: ClientEdict, ambientlight: Vector, shadelight: Vector, lightOrigin: Vector, dynamicShadeLight: Vector, dynamicLightOrigin: Vector): EntityLightValues {
    const teleported = e.smoothedLightOrigin !== null && lightOrigin.distanceTo(e.smoothedLightOrigin) > EntityLighting.#lightTeleportDistance;

    if (e.smoothedAmbientLight === null || teleported) {
      e.smoothedAmbientLight = ambientlight.copy();
      e.smoothedShadeLight = shadelight.copy();
      e.smoothedLightOrigin = lightOrigin.copy();
      e.smoothedDynamicShadeLight = dynamicShadeLight.copy();
      e.smoothedDynamicLightOrigin = dynamicLightOrigin.copy();

      return [ e.smoothedAmbientLight, e.smoothedShadeLight, e.smoothedLightOrigin, e.smoothedDynamicShadeLight, e.smoothedDynamicLightOrigin ];
    }

    const deltaTime = Host.frametime;

    EntityLighting.SmoothVectorTowards(e.smoothedAmbientLight, ambientlight, deltaTime);
    EntityLighting.SmoothVectorTowards(e.smoothedShadeLight!, shadelight, deltaTime);
    EntityLighting.SmoothVectorTowards(e.smoothedLightOrigin!, lightOrigin, deltaTime);
    EntityLighting.SmoothVectorTowards(e.smoothedDynamicShadeLight!, dynamicShadeLight, deltaTime);
    EntityLighting.SmoothVectorTowards(e.smoothedDynamicLightOrigin!, dynamicLightOrigin, deltaTime);

    return [ e.smoothedAmbientLight, e.smoothedShadeLight!, e.smoothedLightOrigin!, e.smoothedDynamicShadeLight!, e.smoothedDynamicLightOrigin! ];
  }

  /**
   * Eases `current` towards `target` component-wise in place, using
   * `#lightSmoothingSharpness` as the exponential decay rate.
   */
  static SmoothVectorTowards(current: Vector, target: Vector, deltaTime: number): void {
    current[0] = V.SmoothValue(current[0], target[0], EntityLighting.#lightSmoothingSharpness, deltaTime);
    current[1] = V.SmoothValue(current[1], target[1], EntityLighting.#lightSmoothingSharpness, deltaTime);
    current[2] = V.SmoothValue(current[2], target[2], EntityLighting.#lightSmoothingSharpness, deltaTime);
  }
}

export default EntityLighting;
