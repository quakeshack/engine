#version 300 es
precision highp float;

uniform vec3 uViewOrigin;
uniform mat3 uViewAngles;
uniform mat4 uPerspective;

in vec3 aPosition;
in vec2 aTexCoord;
in vec3 aColor;

out vec2 vTexCoord;
out vec3 vColor;
out float vFog;

uniform vec4 uFogParams; // start, end, density, mode

void main(void) {
  vec3 position = uViewAngles * (aPosition - uViewOrigin);

  gl_Position = uPerspective * vec4(position.xz, -position.y, 1.0);

  vTexCoord = aTexCoord;
  vColor = aColor;
  float dist = length(aPosition - uViewOrigin);
  float fogLinear = clamp((uFogParams.y - dist) / max(0.0001, uFogParams.y - uFogParams.x), 0.0, 1.0);
  float fogExp = clamp(exp(-uFogParams.z * dist), 0.0, 1.0);
  float fogExp2 = clamp(exp(-uFogParams.z * uFogParams.z * dist * dist), 0.0, 1.0);

  float isNoFog = step(uFogParams.w, -0.5);
  float isLinear = step(uFogParams.w, 0.5) * (1.0 - isNoFog);
  float isExp = step(abs(uFogParams.w - 1.0), 0.5) * (1.0 - isNoFog - isLinear);

  vFog = mix(mix(mix(fogExp2, fogExp, isExp), fogLinear, isLinear), 1.0, isNoFog);
}
