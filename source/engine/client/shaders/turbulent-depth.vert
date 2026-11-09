#version 300 es
precision highp float;

uniform vec3 uOrigin;
uniform mat3 uAngles;
uniform vec3 uViewOrigin;
uniform mat3 uViewAngles;
uniform mat4 uPerspective;

in vec3 aPosition;

void main(void) {
  // The surface where turbulent.vert puts it, which does not displace it, so the boundary depth matches what is drawn.
  vec3 position = uViewAngles * (uAngles * aPosition + uOrigin - uViewOrigin);
  gl_Position = uPerspective * vec4(position.xz, -position.y, 1.0);
}
