#version 300 es
precision highp float;

uniform vec3 uOrigin;
uniform mat3 uAngles;
uniform vec3 uViewOrigin;
uniform mat3 uViewAngles;
uniform mat4 uPerspective;
uniform float uTime;

in vec3 aPosition;

void main(void) {
  // Apply the same time-based vertex warp as turbulent.vert so depth matches.
  vec3 pos = aPosition;
  pos.z += sin(aPosition.x + uTime) * 0.5 - 0.25;
  pos.z += cos(aPosition.y + uTime) * 0.5 - 0.25;

  vec3 position = uViewAngles * (uAngles * pos + uOrigin - uViewOrigin);
  gl_Position = uPerspective * vec4(position.xz, -position.y, 1.0);
}
