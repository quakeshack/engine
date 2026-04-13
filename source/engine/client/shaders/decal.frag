#version 300 es
precision highp float;
precision highp sampler2D;

layout(location = 0) out vec4 fragColor;
layout(location = 1) out vec4 fragEmissive;

uniform float uGamma;
uniform sampler2D tTexture;

in vec2 vTexCoord;
in vec3 vColor;
in float vFog;
uniform vec3 uFogColor;

void main(void) {
  vec4 texColor = texture(tTexture, vTexCoord);
  texColor.rgb *= vColor;

  fragColor = texColor;
  fragColor.rgb = pow(fragColor.rgb, vec3(uGamma));

  if (fragColor.a < 0.01) discard;

  // apply fog
  vec3 finalRgb = mix(uFogColor, fragColor.rgb, vFog);
  fragColor = vec4(finalRgb, fragColor.a);
  fragEmissive = vec4(0.0);
}
