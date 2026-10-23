#version 300 es
precision highp float;
precision highp sampler2DArray;

out vec4 fragColor;

uniform vec3 uColor;
uniform float uAlpha;
#include "sprite-texel.glsl"

in vec3 vTexCoord;
in vec2 vBlend;

// The output is premultiplied (blend function ONE, ONE_MINUS_SRC_ALPHA): the tint scales the color, uAlpha all channels.
void main(void) {
  vec4 texel = sampleSpriteTexel(vTexCoord, vBlend);

  fragColor = vec4(texel.rgb * uColor, texel.a * (1.0 - spriteIsAdditive())) * uAlpha;
}
