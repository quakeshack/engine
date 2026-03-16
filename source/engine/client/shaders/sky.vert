#version 300 es
precision highp float;

uniform mat3 uViewAngles;
uniform mat4 uPerspective;
uniform vec3 uScale;

in vec3 aPosition;

out vec2 vTexCoord;
out float vFog;

uniform vec4 uFogParams; // start, end, density, mode

void main(void) {
  vec3 position = uViewAngles * (aPosition * uScale * 18918.0);

  gl_Position = uPerspective * vec4(position.xz, -position.y, 1.0);

  vTexCoord = aPosition.xy * uScale.xy * 1.5;

  if (uFogParams.w < 0.0) {
    vFog = 1.0;
  } else {
    vFog = 0.0;
  }
}
