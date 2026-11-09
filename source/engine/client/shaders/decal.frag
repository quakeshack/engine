#version 300 es
precision highp float;
precision highp sampler2D;

layout(location = 0) out vec4 fragColor;
layout(location = 1) out vec4 fragEmissive;

uniform float uGamma;
uniform sampler2D tTexture;

in vec2 vTexCoord;
in vec3 vColor;
#include "fog-fragment.glsl"

void main(void) {
  vec4 texColor = texture(tTexture, vTexCoord);

  if (texColor.a < 0.01) {
    discard;
  }

  // apply gamma and fog
  vec3 color = pow(texColor.rgb * vColor, vec3(uGamma));
  fragColor = vec4(mix(uFogColor, color, vFog), texColor.a);
  fragEmissive = vec4(0.0);
}
