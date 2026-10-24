// Point light (cube) shadow test, shared by brush.frag and shadow-entity.glsl. The light's cube is rendered without
// any caster bias (see ShadowMap.renderPointLightShadow()): everything that keeps a lit surface from shadowing
// itself happens here, per fragment, scaled by how large one shadow map texel is at the fragment's distance.

// Depth bias along the cube face axis, in shadow map texels (r_shadow_point_bias).
uniform float uPointShadowBias;

// Offset of the lookup along the surface normal, in shadow map texels, scaled by the sine of the angle between the
// normal and the light (r_shadow_point_normal_bias).
uniform float uPointShadowNormalBias;

/** Near plane of the cube face projection, kept in sync with POINT_NEAR in ShadowMap.ts. */
const float POINT_SHADOW_NEAR = 1.0;

/** Radius of the PCF taps around the lookup, in shadow map texels. */
const float POINT_SHADOW_PCF_RADIUS = 1.25;

/**
 * One hardware-filtered tap of the cube shadow map. The reference depth is the window-space depth the cube face
 * projection stores for this point (ShadowMap.buildPointFaceMatrix), computed from the distance along the face axis
 * after the bias has been taken off it, so the bias is in world units and means the same at every distance.
 * @param lightToPoint Vector from the light to the point to test.
 * @param bias Depth bias in world units.
 * @param far Far plane of the cube face projection (the light's radius).
 * @returns 1 where the point is lit, 0 where it is occluded.
 */
float tapPointShadow(samplerCubeShadow shadowMap, vec3 lightToPoint, float bias, float far) {
  vec3 axisDistances = abs(lightToPoint);
  float viewZ = max(max(axisDistances.x, axisDistances.y), axisDistances.z);
  float z = max(viewZ - bias, POINT_SHADOW_NEAR);
  float refDepth = far * (z - POINT_SHADOW_NEAR) / ((far - POINT_SHADOW_NEAR) * z);
  return texture(shadowMap, vec4(lightToPoint, refDepth));
}

/**
 * Point light shadow test of one surface point, softened by 5 taps.
 *
 * A texel of the cube map covers a patch of the receiver that grows with the distance from the light and with how
 * steeply the light grazes the surface. Across that patch the receiver's own depth changes, so a constant bias is
 * either too small at grazing angles (the surface shadows itself in stripes, shadow acne) or so large elsewhere that
 * shadows detach from their casters. Instead the lookup is moved off the surface along its normal by a few texels
 * (normal offset), scaled by the sine of the angle to the light, which is exactly what a grazing angle needs. A
 * surface that faces away from the light is moved away from it, so it stays in its own shadow.
 *
 * The PCF taps lie in the receiver's plane and each computes its own reference depth, so the kernel follows the
 * surface instead of comparing one depth against texels where the surface is nearer to or farther from the light.
 * @param worldPos World position of the fragment.
 * @param normal World-space surface normal, need not be normalized. A zero normal disables the normal offset.
 * @param lightPos World position of the light.
 * @param far Far plane of the cube face projection (the light's radius).
 * @returns The lit fraction, 0 (occluded) to 1 (lit).
 */
float samplePointShadowMap(samplerCubeShadow shadowMap, vec3 worldPos, vec3 normal, vec3 lightPos, float far) {
  vec3 lightToPoint = worldPos - lightPos;
  float fragDist = length(lightToPoint);
  vec3 towardLight = -lightToPoint / max(fragDist, 0.0001);

  // A 90° cube face spans twice the distance along its axis over its resolution.
  vec3 axisDistances = abs(lightToPoint);
  float viewZ = max(max(axisDistances.x, axisDistances.y), axisDistances.z);
  float texelWorld = 2.0 * viewZ / float(textureSize(shadowMap, 0).x);

  float normalLen = length(normal);
  vec3 surfaceNormal = mix(towardLight, normal / max(normalLen, 0.0001), step(0.0001, normalLen));
  float cosTheta = dot(surfaceNormal, towardLight);
  float sinTheta = sqrt(clamp(1.0 - cosTheta * cosTheta, 0.0, 1.0));
  vec3 receiver = lightToPoint + surfaceNormal * (texelWorld * uPointShadowNormalBias * sinTheta);

  float useAltUp = step(0.99, abs(surfaceNormal.z));
  vec3 upHint = mix(vec3(0.0, 0.0, 1.0), vec3(1.0, 0.0, 0.0), useAltUp);
  vec3 tangent = normalize(cross(upHint, surfaceNormal)) * (texelWorld * POINT_SHADOW_PCF_RADIUS);
  vec3 bitangent = normalize(cross(surfaceNormal, tangent)) * (texelWorld * POINT_SHADOW_PCF_RADIUS);

  float bias = texelWorld * uPointShadowBias;
  float lit = 0.0;
  lit += tapPointShadow(shadowMap, receiver, bias, far);
  lit += tapPointShadow(shadowMap, receiver + tangent, bias, far);
  lit += tapPointShadow(shadowMap, receiver - tangent, bias, far);
  lit += tapPointShadow(shadowMap, receiver + bitangent, bias, far);
  lit += tapPointShadow(shadowMap, receiver - bitangent, bias, far);
  return lit * 0.2;
}
