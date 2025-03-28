uniform vec3 uOrigin;
uniform vec3 uViewOrigin;
uniform mat3 uViewAngles;
uniform mat4 uPerspective;
uniform float uRadius;

attribute vec3 aPosition;

varying float vAlpha;

void main(void) {
  vec3 position = aPosition * 0.35 * uRadius + uViewAngles * (uOrigin - uViewOrigin);
  gl_Position = uPerspective * vec4(position.xz, -position.y, 1.0);
  vAlpha = aPosition.y * -0.2;
}
