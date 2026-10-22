// Lighting of the lit entity programs (alias, mesh, player): top-down and point-light shadows, the shade and
// dynamic light terms, and a Blinn-Phong specular highlight. The program keeps its texturing, fog and emissive output.
#include "shadow-entity.glsl"
#include "entity-varyings-in.glsl"

uniform vec3 uAmbientLight;
uniform vec3 uShadeLight;
uniform vec3 uDynamicShadeLight;

/**
 * Lighting of one fragment of a lit entity.
 * @param specularShininess Blinn-Phong exponent, fixed per model kind.
 * @param specularIntensity Strength of the highlight, fixed per model kind.
 * @param lighting Shadowed diffuse light, to multiply the base color with.
 * @param specular Shadowed highlight, to add to the lit color.
 */
void computeEntityLighting(float specularShininess, float specularIntensity, out vec3 lighting, out vec3 specular) {
  // Top-down shadow — fades smoothly to fully-lit at the coverage edge (no hard clip).
  float shadow = sampleLocalShadow(tShadowMap, vShadowCoord);

  // Mask the shadow off surfaces that face away from the top-down light
  // direction — see brush.frag's main() for why.
  float shadowFacing = clamp(dot(normalize(vNormal), -uShadowLightDir), 0.0, 1.0);
  shadow = mix(1.0, shadow, shadowFacing);

  // Point light shadows — entity shadows from up to 3 nearby dynamic lights.
  // Combined via min() since this model only tracks one dominant analytic
  // dlight term below, so it darkens if occluded from any active light.
  float pointShadow0 = samplePointShadow(tPointShadowMap0, uPointLightPos0, uPointLightRadius0);
  float pointShadow1 = samplePointShadow(tPointShadowMap1, uPointLightPos1, uPointLightRadius1);
  float pointShadow2 = samplePointShadow(tPointShadowMap2, uPointLightPos2, uPointLightRadius2);
  float pointShadow = min(min(pointShadow0, pointShadow1), pointShadow2);

  // A nearby, unoccluded shadow-casting dlight locally fills in the top-down
  // shadow — see brush.frag's main() for why. pointShadow already accounts
  // for the dlight being blocked by geometry between it and this fragment.
  float dlightFill = clamp(vDynamicLightDot * max(uDynamicShadeLight.r, max(uDynamicShadeLight.g, uDynamicShadeLight.b)) * pointShadow, 0.0, 1.0);
  shadow = max(shadow, dlightFill);

  // Point shadow only occludes the dynamic light term — dlights are
  // additive, so it must never darken the base ambient/shade lighting.
  lighting = ((vLightDot * uShadeLight + uAmbientLight)
            + vDynamicLightDot * uDynamicShadeLight * pointShadow) * shadow;

  // Blinn-Phong specular, tinted by the light color rather than the diffuse
  // texture (a dielectric-style highlight), gated by the same shadow terms
  // as the matching diffuse contribution above.
  vec3 N = normalize(vNormal);
  vec3 V = normalize(vViewVec);
  float specDot = max(0.0, dot(N, normalize(vLightVec + V)));
  float dynamicSpecDot = max(0.0, dot(N, normalize(vDynamicLightVec + V)));
  specular = (pow(specDot, specularShininess) * uShadeLight * shadow
                 + pow(dynamicSpecDot, specularShininess) * uDynamicShadeLight * pointShadow) * specularIntensity;
}
