#version 300 es
precision highp float;

uniform vec3 uOrigin;
uniform mat3 uAngles;
uniform vec3 uViewOrigin;
uniform mat3 uViewAngles;
uniform mat4 uPerspective;

uniform bool uPerformDotLighting;

uniform float uTime;
// fog uniforms
uniform vec3 uFogColor;
uniform vec4 uFogParams; // start, end, density, mode

in vec3 aPosition;
in vec3 aNormal;
in vec4 aTexCoord;
in vec4 aLightStyle;
in vec3 aTangent;
// in vec3 aBitangent;

out vec4 vTexCoord;
out vec4 vLightStyle;
out float vFog;

out vec3 vPosition;
out vec3 vNormal;
out vec3 vFallbackLight;
out vec2 vDlightTexCoord;
out float vHasLightmap;

void main(void) {
  vec3 aPositionA = aPosition;

  aPositionA.z += sin(aPosition.x + uTime) * 0.5 - 0.25;
  aPositionA.z += cos(aPosition.y + uTime) * 0.5 - 0.25;

  vec3 position = uViewAngles * (uAngles * aPositionA + uOrigin - uViewOrigin);
  gl_Position = uPerspective * vec4(position.xz, -position.y, 1.0);

  vTexCoord = aTexCoord;
  vLightStyle = aLightStyle;
  vPosition = position;
  vNormal = uViewAngles * vec3(0.0, 0.0, 1.0);
  vFallbackLight = aNormal;
  vDlightTexCoord = aTangent.xy;
  vHasLightmap = aTangent.z;

  // compute fog based on distance from camera
  float dist = length((uAngles * aPositionA + uOrigin) - uViewOrigin);
  float distNorm = clamp((dist - uFogParams.x) / max(0.0001, uFogParams.y - uFogParams.x), 0.0, 1.0);

  float fogLinear = clamp((uFogParams.y - dist) / max(0.0001, uFogParams.y - uFogParams.x), 0.0, 1.0);
  float fogExp = clamp(exp(-uFogParams.z * distNorm), 0.0, 1.0);
  float fogExp2 = clamp(exp(-uFogParams.z * uFogParams.z * distNorm * distNorm), 0.0, 1.0);

  float isNoFog = step(uFogParams.w, -0.5);
  float isLinear = step(uFogParams.w, 0.5) * (1.0 - isNoFog);
  float isExp = step(abs(uFogParams.w - 1.0), 0.5) * (1.0 - isNoFog - isLinear);

  vFog = mix(mix(mix(fogExp2, fogExp, isExp), fogLinear, isLinear), 1.0, isNoFog);
}
