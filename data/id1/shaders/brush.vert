uniform vec3 uOrigin;
uniform mat3 uAngles;
uniform vec3 uViewOrigin;
uniform mat3 uViewAngles;
uniform mat4 uPerspective;

attribute vec3 aPosition;
attribute vec4 aTexCoord;
attribute vec4 aLightStyle;

varying vec4 vTexCoord;
varying vec4 vLightStyle;

void main(void) {
  vec3 position = uViewAngles * (uAngles * aPosition + uOrigin - uViewOrigin);
  gl_Position = uPerspective * vec4(position.xz, -position.y, 1.0);
  vTexCoord = aTexCoord;
  vLightStyle = aLightStyle;
}
