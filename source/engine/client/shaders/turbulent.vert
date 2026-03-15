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
  float denom = max(0.0001, uFogParams.y - uFogParams.x);
  float distNorm = clamp((dist - uFogParams.x) / denom, 0.0, 1.0);
  if (uFogParams.w < 0.0) {
    vFog = 1.0;
  } else if (uFogParams.w < 0.5) {
    // linear: fog = (end - dist) / (end - start)
    float denom = max(0.0001, uFogParams.y - uFogParams.x);
    vFog = clamp((uFogParams.y - dist) / denom, 0.0, 1.0);
  } else if (abs(uFogParams.w - 1.0) < 0.5) {
    // exp (apply density across [start,end])
    vFog = clamp(exp(-uFogParams.z * distNorm), 0.0, 1.0);
  } else {
    // exp2 (apply density across [start,end])
    vFog = clamp(exp(-uFogParams.z * uFogParams.z * distNorm * distNorm), 0.0, 1.0);
  }
}
