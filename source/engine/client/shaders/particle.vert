#version 300 es
precision highp float;

uniform vec3 uViewOrigin;
uniform mat3 uViewAngles;
uniform mat4 uPerspective;
uniform float uGamma;

in vec3 aOrigin;
in vec2 aCoord;
in float aScale;
in vec3 aColor;

out vec2 vCoord;
// one color per particle, gamma corrected here rather than for every fragment of the quad
flat out vec3 vColor;

#include "fog-vertex.glsl"

void main(void) {
  vec2 point = aCoord * aScale;
  vec3 position = vec3(point.x, 0.0, point.y) + uViewAngles * (aOrigin - uViewOrigin);

  gl_Position = uPerspective * vec4(position.xz, -position.y, 1.0);

  vCoord = aCoord;
  vColor = pow(aColor, vec3(uGamma));
  vFog = computeFog(length(aOrigin - uViewOrigin));
}
