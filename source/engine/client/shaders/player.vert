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
uniform mat4 uLightSpaceMatrix;

in vec3 aPositionA;
in vec3 aPositionB;
in vec3 aNormal;
in vec2 aTexCoord;

out vec2 vTexCoord;
out float vLightDot;
out float vDynamicLightDot;
out float vFog;
out vec4 vShadowCoord;
out vec3 vWorldPos;
out vec3 vNormal;
out vec3 vLightVec;
out vec3 vDynamicLightVec;
out vec3 vViewVec;

uniform vec4 uFogParams; // start, end, density, mode

void main(void) {
  vec3 lerpPos = mix(aPositionA, aPositionB, uInterpolation);
  vec3 worldPos = uAngles * lerpPos + uOrigin;
  vWorldPos = worldPos;
  vec3 position = uViewAngles * (worldPos - uViewOrigin);

  gl_Position = uPerspective * vec4(position.xz, -position.y, 1.0);

  // Shadow coordinates in light space
  vShadowCoord = uLightSpaceMatrix * vec4(worldPos, 1.0);

  vTexCoord = aTexCoord;
  vec3 worldNormal = uAngles * aNormal;
  vec3 lightDir = normalize(worldPos - uLightVec);
  vec3 dynamicLightDir = normalize(worldPos - uDynamicLightVec);
  vLightDot = max(0.0, dot(worldNormal, lightDir));
  vDynamicLightDot = max(0.0, dot(worldNormal, dynamicLightDir));
  vNormal = worldNormal;
  vLightVec = lightDir;
  vDynamicLightVec = dynamicLightDir;
  vViewVec = normalize(uViewOrigin - worldPos);

  // fog distance (world position)
  float dist = length(worldPos - uViewOrigin);
  float fogLinear = clamp((uFogParams.y - dist) / max(0.0001, uFogParams.y - uFogParams.x), 0.0, 1.0);
  float fogExp = clamp(exp(-uFogParams.z * dist), 0.0, 1.0);
  float fogExp2 = clamp(exp(-uFogParams.z * uFogParams.z * dist * dist), 0.0, 1.0);

  float isNoFog = step(uFogParams.w, -0.5);
  float isLinear = step(uFogParams.w, 0.5) * (1.0 - isNoFog);
  float isExp = step(abs(uFogParams.w - 1.0), 0.5) * (1.0 - isNoFog - isLinear);

  vFog = mix(mix(mix(fogExp2, fogExp, isExp), fogLinear, isLinear), 1.0, isNoFog);
}
