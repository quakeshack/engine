#version 300 es
precision highp float;

uniform vec4 uRect;
uniform vec3 uViewOrigin;
uniform mat3 uViewAngles;
uniform mat4 uPerspective;

in vec3 aPosition;
// xy: texture coordinate, z: layer of the array texture
in vec3 aTexCoord;
// x: layer of the next image, y: how far to fade from this image to that one (0 shows only this image)
in vec2 aBlend;

out vec3 vTexCoord;
out vec2 vBlend;

#include "fog-vertex.glsl"

void main(void) {
  vec3 position = uViewAngles * (aPosition - uViewOrigin);

  gl_Position = uPerspective * vec4(position.xz, -position.y, 1.0);

  vTexCoord = aTexCoord;
  vBlend = aBlend;
  vFog = computeFog(length(aPosition - uViewOrigin));
}
