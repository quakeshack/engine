#version 300 es
precision highp float;
precision highp sampler2D;

out vec4 fragColor;

uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform sampler2D tBoundaryDepth;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform mat4 uPerspective;

in vec2 vTexCoord;

float linearizeDepth(highp float depth) {
  highp float z_ndc = depth * 2.0 - 1.0;
  return uPerspective[3][2] / (z_ndc + uPerspective[2][2]);
}

void main(void) {
  vec4 sceneColor = texture(tScene, vTexCoord);

  highp float rawSceneDepth    = texture(tDepth, vTexCoord).r;
  highp float rawBoundaryDepth = texture(tBoundaryDepth, vTexCoord).r;

  float sceneLinear    = linearizeDepth(rawSceneDepth);
  float boundaryLinear = linearizeDepth(rawBoundaryDepth);

  // Fog extends from the camera to whichever is closer: scene geometry or the water
  // surface. When no surface was captured for this direction (boundary = 1.0 / far
  // plane), min() correctly falls back to the scene geometry depth.
  float fogDepth  = min(sceneLinear, boundaryLinear);
  float fogFactor = clamp(1.0 - exp(-uFogDensity * fogDepth), 0.0, 1.0);

  fragColor = vec4(mix(sceneColor.rgb, uFogColor, fogFactor), sceneColor.a);
}
