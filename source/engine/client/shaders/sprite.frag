#version 300 es
precision highp float;
precision highp sampler2D;

layout(location = 0) out vec4 fragColor;
layout(location = 1) out vec4 fragEmissive;

uniform float uAlpha;
uniform float uGamma;
uniform sampler2D tTexture;
uniform float uBloomEmissiveScale;

in vec2 vTexCoord;
in float vFog;
uniform vec3 uFogColor;

void main(void) {
  fragColor = texture(tTexture, vTexCoord);
  fragColor.rgb = pow(fragColor.rgb, vec3(uGamma));
  if (fragColor.a < 0.25) discard;
  fragColor.a = fragColor.a * uAlpha;
  // apply fog
  vec3 finalRgb = mix(uFogColor, fragColor.rgb, vFog);
  fragColor = vec4(finalRgb, fragColor.a);
  fragEmissive = vec4(finalRgb * uBloomEmissiveScale, fragColor.a);
}
