uniform mat3 uViewAngles;
uniform mat4 uPerspective;
uniform vec3 uScale;

attribute vec3 aPosition;

varying vec2 vTexCoord;

void main(void) {
  vec3 position = uViewAngles * (aPosition * uScale * 18918.0);

  gl_Position = uPerspective * vec4(position.xz, -position.y, 1.0);

  vTexCoord = aPosition.xy * uScale.xy * 1.5;
}
