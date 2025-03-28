uniform vec3 uViewOrigin;
uniform mat3 uViewAngles;
uniform mat4 uPerspective;
uniform float uScale;

attribute vec3 aOrigin;
attribute vec2 aCoord;
attribute float aScale;
attribute vec3 aColor;

varying vec2 vCoord;
varying vec3 vColor;

void main(void) {
  vec2 point = aCoord * aScale;
  vec3 position = vec3(point.x, 0.0, point.y) + uViewAngles * (aOrigin - uViewOrigin);

  gl_Position = uPerspective * vec4(position.xz, -position.y, 1.0);

  vCoord = aCoord;
  vColor = aColor;
}
