#version 300 es
precision highp float;

uniform vec4 uRect;
uniform vec3 uViewOrigin;
uniform mat3 uViewAngles;
uniform mat4 uPerspective;

in vec3 aPosition;
in vec2 aTexCoord;

out vec2 vTexCoord;

#include "fog-vertex.glsl"

void main(void) {
  vec3 position = uViewAngles * (aPosition - uViewOrigin);

  gl_Position = uPerspective * vec4(position.xz, -position.y, 1.0);

  vTexCoord = aTexCoord;
  vFog = computeFog(length(aPosition - uViewOrigin));
}
