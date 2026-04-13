#version 300 es
precision highp float;
precision highp sampler2D;

layout(location = 0) out vec4 fragColor;
layout(location = 1) out vec4 fragEmissive;

uniform float uGamma;
uniform vec2 uTime;
uniform float uBloomEmissiveScale;
uniform sampler2D tSolid;
uniform sampler2D tAlpha;

in vec2 vTexCoord;
in float vFog;
uniform vec3 uFogColor;

void main(void) {
  vec4 alpha = texture(tAlpha, vTexCoord + uTime.x);

  fragColor = vec4(mix(texture(tSolid, vTexCoord + uTime.y).rgb, alpha.rgb, alpha.a), 1.0);

  fragColor.rgb = pow(fragColor.rgb, vec3(uGamma));
  // apply fog to sky RGB
  vec3 finalRgb = mix(uFogColor, fragColor.rgb, vFog);
  fragColor = vec4(finalRgb, fragColor.a);
  fragEmissive = vec4(finalRgb * uBloomEmissiveScale, fragColor.a);
}
