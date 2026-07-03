#version 300 es
precision highp float;

uniform vec3 uOrigin;
uniform mat3 uAngles;
uniform mat4 uLightSpaceMatrix;
uniform float uInterpolation;
uniform vec3 uLightPos;
uniform float uNormalBias;

in vec3 aPositionA;
in vec3 aPositionB;
in vec3 aNormalA;
in vec3 aNormalB;

void main(void) {
  vec3 localPos = mix(aPositionA, aPositionB, uInterpolation);
  vec3 localNormal = mix(aNormalA, aNormalB, uInterpolation);
  vec3 worldPos = uAngles * localPos + uOrigin;

  // Depth bias — push radially away from the light, not along the surface
  // normal (see shadow-point.vert for why the normal direction is wrong here).
  vec3 worldNormal = uAngles * localNormal;
  float normalLen = length(worldNormal);
  worldNormal /= max(normalLen, 0.0001);
  vec3 toLight = worldPos - uLightPos;
  float distToLight = length(toLight);
  vec3 lightDir = toLight / max(distToLight, 0.0001);
  float cosTheta = dot(worldNormal, lightDir);
  float slopeScale = mix(0.35, 1.0, sqrt(1.0 - cosTheta * cosTheta));

  // See shadow-point.vert: scale the bias down quadratically below the
  // reference distance so it doesn't get amplified into acne-causing noise
  // when a dlight sits right next to a surface.
  const float kBiasReferenceDistance = 48.0;
  float distScale = clamp((distToLight * distToLight) / (kBiasReferenceDistance * kBiasReferenceDistance), 0.05, 1.0);

  worldPos += lightDir * uNormalBias * slopeScale * distScale * step(0.0001, normalLen);

  gl_Position = uLightSpaceMatrix * vec4(worldPos, 1.0);
}
