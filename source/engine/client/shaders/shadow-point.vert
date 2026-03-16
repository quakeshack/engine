#version 300 es
precision highp float;

uniform vec3 uOrigin;
uniform mat3 uAngles;
uniform mat4 uLightSpaceMatrix;
uniform vec3 uLightPos;
uniform float uNormalBias;

in vec3 aPosition;
in vec3 aNormal;

void main(void) {
  vec3 worldPos = uAngles * aPosition + uOrigin;

  // Normal offset bias: push the vertex along its surface normal,
  // scaled by the sine of the angle between normal and light direction.
  // Surfaces facing the light get near-zero offset (no peter panning),
  // while grazing-angle surfaces get maximum offset (no acne).
  vec3 worldNormal = uAngles * aNormal;
  float normalLen = length(worldNormal);
  if (normalLen > 0.0) {
    worldNormal /= normalLen;
    vec3 lightDir = normalize(worldPos - uLightPos);
    float cosTheta = dot(worldNormal, lightDir);
    worldPos += worldNormal * uNormalBias * sqrt(1.0 - cosTheta * cosTheta);
  }

  gl_Position = uLightSpaceMatrix * vec4(worldPos, 1.0);
}
