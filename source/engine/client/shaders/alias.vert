#version 300 es
precision highp float;

uniform vec3 uOrigin;
uniform mat3 uAngles;
uniform vec3 uViewOrigin;
uniform mat3 uViewAngles;
uniform mat4 uPerspective;
uniform vec3 uLightVec;
uniform vec3 uDynamicLightVec;
uniform float uInterpolation;

// Shadow mapping
uniform mat4 uLightSpaceMatrix0;
uniform mat4 uLightSpaceMatrix1;
uniform mat4 uLightSpaceMatrix2;

in vec3 aPositionA;
in vec3 aPositionB;
in vec3 aNormal;
in vec2 aTexCoord;

out vec2 vTexCoord;
out float vLightDot;
out float vDynamicLightDot;
out float vFog;
out vec4 vShadowCoord0;
out vec4 vShadowCoord1;
out vec4 vShadowCoord2;
out vec3 vWorldPos;

uniform vec4 uFogParams; // start, end, density, mode

void main(void) {
  vec3 lerpPos = mix(aPositionA, aPositionB, uInterpolation);
  vec3 worldPos = uAngles * lerpPos + uOrigin;
  vWorldPos = worldPos;
  vec3 position = uViewAngles * (worldPos - uViewOrigin);

  gl_Position = uPerspective * vec4(position.xz, -position.y, 1.0);

  // Shadow coordinates in light space
  vec4 shadowWorldPos = vec4(worldPos, 1.0);
  vShadowCoord0 = uLightSpaceMatrix0 * shadowWorldPos;
  vShadowCoord1 = uLightSpaceMatrix1 * shadowWorldPos;
  vShadowCoord2 = uLightSpaceMatrix2 * shadowWorldPos;

  vTexCoord = aTexCoord;
  vLightDot = max(0.0, dot(aNormal, normalize(worldPos - uLightVec)));
  vDynamicLightDot = max(0.0, dot(aNormal, normalize(worldPos - uDynamicLightVec)));

  // fog distance (world position)
  float dist = length(worldPos - uViewOrigin);
  if (uFogParams.w < 0.0) {
    vFog = 1.0;
  } else if (uFogParams.w < 0.5) {
    float denom = max(0.0001, uFogParams.y - uFogParams.x);
    vFog = clamp((uFogParams.y - dist) / denom, 0.0, 1.0);
  } else if (abs(uFogParams.w - 1.0) < 0.5) {
    vFog = clamp(exp(-uFogParams.z * dist), 0.0, 1.0);
  } else {
    vFog = clamp(exp(-uFogParams.z * uFogParams.z * dist * dist), 0.0, 1.0);
  }
}
