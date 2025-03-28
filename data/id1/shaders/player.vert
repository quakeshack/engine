uniform vec3 uOrigin;
uniform mat3 uAngles;
uniform vec3 uViewOrigin;
uniform mat3 uViewAngles;
uniform mat4 uPerspective;
uniform vec3 uLightVec;

attribute vec3 aPositionA;
attribute vec3 aNormal;
attribute vec2 aTexCoord;

varying vec2 vTexCoord;
varying float vLightDot;

void main(void) {
  vec3 position = uViewAngles * (uAngles * aPositionA + uOrigin - uViewOrigin);

  gl_Position = uPerspective * vec4(position.xz, -position.y, 1.0);

  vTexCoord = aTexCoord;
  vLightDot = dot(aNormal, uLightVec);
}
