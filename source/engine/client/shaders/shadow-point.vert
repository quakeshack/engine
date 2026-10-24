#version 300 es
precision highp float;

uniform vec3 uOrigin;
uniform mat3 uAngles;
uniform mat4 uLightSpaceMatrix;

in vec3 aPosition;

void main(void) {
  // No caster bias: the receivers bias their own lookup, per fragment and
  // scaled by the texel size there (see samplePointShadowMap in
  // shadow-point.glsl). A per-vertex push is interpolated across a triangle,
  // so on a large world face it does not follow what a fragment needs.
  vec3 worldPos = uAngles * aPosition + uOrigin;
  gl_Position = uLightSpaceMatrix * vec4(worldPos, 1.0);
}
