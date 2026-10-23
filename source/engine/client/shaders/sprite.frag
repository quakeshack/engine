#version 300 es
precision highp float;
precision highp sampler2DArray;

layout(location = 0) out vec4 fragColor;
layout(location = 1) out vec4 fragEmissive;

uniform float uAlpha;
uniform float uGamma;
// 0: alpha tested, 1: alpha blended, 2: additive
uniform float uBlendMode;
uniform sampler2DArray tTexture;
uniform float uBloomEmissiveScale;

in vec3 vTexCoord;
in vec2 vBlend;
#include "fog-fragment.glsl"

// The texture and the output hold premultiplied alpha (blend function ONE, ONE_MINUS_SRC_ALPHA): an additive
// sprite writes no alpha, so what it covers stays and its color is added; alpha testing drops pixels below a quarter.
void main(void) {
  // premultiplied texels fade linearly into each other
  vec4 texel = mix(texture(tTexture, vTexCoord), texture(tTexture, vec3(vTexCoord.xy, vBlend.x)), vBlend.y);

  if (uBlendMode < 0.5 && texel.a < 0.25) discard;

  float isAdditive = step(1.5, uBlendMode);

  // gamma and fog act on the color itself, so take the alpha out of it first
  vec3 color = pow(texel.rgb / max(texel.a, 0.0001), vec3(uGamma));
  float alpha = texel.a * uAlpha;
  // fog fades an additive sprite to nothing, not to the fog's color
  vec3 finalRgb = mix(uFogColor * (1.0 - isAdditive), color, vFog) * alpha;
  float outputAlpha = alpha * (1.0 - isAdditive);

  fragColor = vec4(finalRgb, outputAlpha);
  fragEmissive = vec4(finalRgb * uBloomEmissiveScale, outputAlpha);
}
