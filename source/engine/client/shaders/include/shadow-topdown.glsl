// The two maps of the top-down shadow (ShadowMap.renderTopDownShadow() and renderTopDownBlockers()) and how far below
// its caster the shadow reaches, shared by brush.frag and shadow-entity.glsl. Each of them filters tShadowMap with its
// own PCF kernel and then calls limitTopDownShadowReach().

// Entity casters only, the nearest one per texel.
uniform sampler2DShadow tShadowMap;

// The nearest world surface below the casters around each texel, 1.0 where there is none.
uniform sampler2DShadow tShadowBlockerMap;

// r_shadow_max_depth in the maps' depth units.
uniform float uShadowMaxDepthNDC;

// How far a receiver may lie below the blocker map's surface and still take the shadow, in the maps' depth units.
uniform float uShadowBlockerBiasNDC;

/**
 * Takes the occlusion of the top-down shadow back where it cannot reach the fragment. The caster map has one layer: it
 * knows how far above the fragment the nearest caster is, not what lies in between, so a caster on a ledge or a
 * catwalk would shadow the floor below it straight through.
 *
 * The shadow ends at the first world surface below the casters, which the blocker map holds: a fragment farther below
 * it is lit. It also reaches no more than uShadowMaxDepthNDC below the caster, so one high above an open floor does
 * not darken it. Both reuse the hardware compare with a shifted reference depth, at the center of the PCF kernel.
 * @param lit Lit fraction from the caster map, 0 (occluded) to 1 (lit).
 * @param shadowCoord Position of the fragment in the shadow maps: texture coordinates and depth, all 0 to 1.
 * @returns The lit fraction left.
 */
float limitTopDownShadowReach(float lit, vec3 shadowCoord) {
  float inRange = texture(tShadowMap, vec3(shadowCoord.xy, shadowCoord.z - uShadowMaxDepthNDC));
  float unblocked = texture(tShadowBlockerMap, vec3(shadowCoord.xy, shadowCoord.z - uShadowBlockerBiasNDC));
  return 1.0 - (1.0 - lit) * inRange * unblocked;
}
