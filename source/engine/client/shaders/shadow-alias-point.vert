#version 300 es
precision highp float;

uniform vec3 uOrigin;
uniform mat3 uAngles;
uniform mat4 uLightSpaceMatrix;
uniform float uInterpolation;
uniform vec3 uLightPos;
uniform float uNormalBias;

in vec3 aPositionA;
in vec3 aPositionB;
in vec3 aNormalA;
in vec3 aNormalB;

void main(void) {
  vec3 localPos = mix(aPositionA, aPositionB, uInterpolation);
  vec3 localNormal = mix(aNormalA, aNormalB, uInterpolation);
  vec3 worldPos = uAngles * localPos + uOrigin;

  // Normal offset bias (see shadow-point.vert for rationale)
  vec3 worldNormal = uAngles * localNormal;
  float normalLen = length(worldNormal);
  worldNormal /= max(normalLen, 0.0001);
  vec3 lightDir = normalize(worldPos - uLightPos);
  float cosTheta = dot(worldNormal, lightDir);
  worldPos += worldNormal * uNormalBias * sqrt(1.0 - cosTheta * cosTheta) * step(0.0001, normalLen);

  gl_Position = uLightSpaceMatrix * vec4(worldPos, 1.0);
}
