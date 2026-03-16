#version 300 es
precision highp float;

uniform vec3 uOrigin;
uniform mat3 uAngles;
uniform mat4 uLightSpaceMatrix;
uniform float uInterpolation;

in vec3 aPositionA;
in vec3 aPositionB;

void main(void) {
  vec3 localPos = mix(aPositionA, aPositionB, uInterpolation);
  vec3 worldPos = uAngles * localPos + uOrigin;
  gl_Position = uLightSpaceMatrix * vec4(worldPos, 1.0);
}
