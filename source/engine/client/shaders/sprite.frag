#version 300 es
precision highp float;
precision highp sampler2DArray;

layout(location = 0) out vec4 fragColor;
layout(location = 1) out vec4 fragEmissive;

uniform float uAlpha;
uniform float uGamma;
uniform sampler2DArray tTexture;
uniform float uBloomEmissiveScale;

in vec3 vTexCoord;
#include "fog-fragment.glsl"

// The texture and the output hold premultiplied alpha (blend function ONE, ONE_MINUS_SRC_ALPHA).
void main(void) {
  vec4 texel = texture(tTexture, vTexCoord);
  if (texel.a < 0.25) discard;

  // gamma and fog act on the color itself, so take the alpha out of it first
  vec3 color = pow(texel.rgb / texel.a, vec3(uGamma));
  float alpha = texel.a * uAlpha;
  vec3 finalRgb = mix(uFogColor, color, vFog) * alpha;

  fragColor = vec4(finalRgb, alpha);
  fragEmissive = vec4(finalRgb * uBloomEmissiveScale, alpha);
}
