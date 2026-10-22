/**
 * 5-tap PCF for the point light cube shadow map: samples the direction plus
 * four small angular offsets along axes perpendicular to it, softening the
 * low-resolution (256px/face) map (a single hardware-filtered tap otherwise
 * shows up as visible speckle). Offsets are applied to the normalized
 * direction so the angular jitter stays constant regardless of the
 * fragment's distance from the light — except close to the light, where a
 * fixed angular offset is no longer safe: a nearby corner or second surface
 * can occupy a large fraction of the light's surrounding sphere, so an
 * offset tap is likely to land on a completely different, disjoint piece of
 * geometry than the one actually being shaded. Comparing that unrelated
 * stored depth against this fragment's refDepth produces exactly the
 * fragment-to-fragment inconsistent result that reads as shadow acne, so the
 * disk is tapered down to a single hard tap as fragDist approaches the light.
 */
float samplePointShadowPCF(samplerCubeShadow shadowMap, vec3 dir, float refDepth, float fragDist) {
  vec3 dirN = normalize(dir);
  float useAltUp = step(0.99, abs(dirN.y));
  vec3 upHint = mix(vec3(0.0, 1.0, 0.0), vec3(1.0, 0.0, 0.0), useAltUp);
  vec3 right = normalize(cross(upHint, dirN));
  vec3 up = cross(dirN, right);

  const float kDiskReferenceDistance = 48.0;
  float diskRadius = 0.02 * clamp(fragDist / kDiskReferenceDistance, 0.0, 1.0);
  float lit = 0.0;
  lit += texture(shadowMap, vec4(dirN, refDepth));
  lit += texture(shadowMap, vec4(normalize(dirN + right * diskRadius), refDepth));
  lit += texture(shadowMap, vec4(normalize(dirN - right * diskRadius), refDepth));
  lit += texture(shadowMap, vec4(normalize(dirN + up * diskRadius), refDepth));
  lit += texture(shadowMap, vec4(normalize(dirN - up * diskRadius), refDepth));
  return lit * 0.2;
}
