#version 300 es
precision highp float;

uniform vec3 uOrigin;
uniform mat3 uAngles;
uniform mat4 uLightSpaceMatrix;
uniform vec3 uLightPos;
uniform float uNormalBias;

in vec3 aPosition;
in vec3 aNormal;

void main(void) {
  vec3 worldPos = uAngles * aPosition + uOrigin;

  // Depth bias: push the vertex radially away from the light (not along
  // its surface normal — for a facing surface the normal points roughly
  // *toward* the light, so offsetting along it would move the caster
  // closer and shrink its stored depth, worsening self-shadow acne instead
  // of fixing it). Pushing along lightDir always increases the stored
  // radial distance, which is exactly what the fragment-side comparison
  // measures, so the push can never land on the wrong side of self.
  // Grazing-angle surfaces get more margin (larger world-space texel
  // footprint); facing surfaces are floored to a minimum rather than zero.
  vec3 worldNormal = uAngles * aNormal;
  float normalLen = length(worldNormal);
  worldNormal /= max(normalLen, 0.0001);
  vec3 toLight = worldPos - uLightPos;
  float distToLight = length(toLight);
  vec3 lightDir = toLight / max(distToLight, 0.0001);
  float cosTheta = dot(worldNormal, lightDir);
  float slopeScale = mix(0.35, 1.0, sqrt(1.0 - cosTheta * cosTheta));

  // The cube map stores hyperbolic (perspective) depth, whose sensitivity to
  // a world-space offset grows with 1/distToLight^2. A push tuned to look
  // right at a normal caster distance therefore becomes a wildly oversized
  // normalized-depth jump when a dlight sits right next to a surface,
  // saturating the stored depth and producing per-texel inconsistent noise
  // (shadow acne) rather than a clean margin. Scale the push down
  // quadratically below the reference distance so its effect in the
  // non-linear depth buffer stays roughly constant instead of exploding;
  // distances at or beyond the reference are unaffected.
  const float kBiasReferenceDistance = 48.0;
  float distScale = clamp((distToLight * distToLight) / (kBiasReferenceDistance * kBiasReferenceDistance), 0.05, 1.0);

  worldPos += lightDir * uNormalBias * slopeScale * distScale * step(0.0001, normalLen);

  gl_Position = uLightSpaceMatrix * vec4(worldPos, 1.0);
}
