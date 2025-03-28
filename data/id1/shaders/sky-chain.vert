uniform vec3 uViewOrigin;
uniform mat3 uViewAngles;
uniform mat4 uPerspective;

attribute vec3 aPosition;

void main(void) {
  vec3 position = uViewAngles * (aPosition - uViewOrigin);
  gl_Position = uPerspective * vec4(position.xz, -position.y, 1.0);
}
