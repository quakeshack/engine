#version 300 es
precision highp float;

uniform vec3 uOrigin;
uniform mat3 uAngles;
uniform mat4 uLightSpaceMatrix;

in vec3 aPosition;

void main(void) {
  vec3 worldPos = uAngles * aPosition + uOrigin;
  gl_Position = uLightSpaceMatrix * vec4(worldPos, 1.0);
}
