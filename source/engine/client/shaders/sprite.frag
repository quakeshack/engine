#version 300 es
precision highp float;
precision highp sampler2DArray;

layout(location = 0) out vec4 fragColor;
layout(location = 1) out vec4 fragEmissive;

uniform float uAlpha;
uniform float uGamma;
// the light of the map on a lit sprite, white for one that is not
uniform vec3 uLight;
uniform float uBloomEmissiveScale;
#include "sprite-texel.glsl"

in vec3 vTexCoord;
in vec2 vBlend;
#include "fog-fragment.glsl"

// The texture and the output hold premultiplied alpha (blend function ONE, ONE_MINUS_SRC_ALPHA), see sprite-texel.glsl.
void main(void) {
  vec4 texel = sampleSpriteTexel(vTexCoord, vBlend);

  float isAdditive = spriteIsAdditive();

  // gamma and fog act on the color itself, so take the alpha out of it first
  vec3 color = pow(texel.rgb / max(texel.a, 0.0001), vec3(uGamma)) * uLight;
  float alpha = texel.a * uAlpha;
  // fog fades an additive sprite to nothing, not to the fog's color
  vec3 finalRgb = mix(uFogColor * (1.0 - isAdditive), color, vFog) * alpha;
  float outputAlpha = alpha * (1.0 - isAdditive);

  fragColor = vec4(finalRgb, outputAlpha);
  fragEmissive = vec4(finalRgb * uBloomEmissiveScale, outputAlpha);
}
