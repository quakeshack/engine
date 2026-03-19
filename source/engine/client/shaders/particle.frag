#version 300 es
precision highp float;

layout(location = 0) out vec4 fragColor;
layout(location = 1) out vec4 fragEmissive;

uniform float uGamma;

in vec2 vCoord;
in vec3 vColor;
in float vFog;
uniform vec3 uFogColor;

void main(void) {
  fragColor = vec4(vColor, 1.0 - smoothstep(0.75, 1.0, length(vCoord)));

  fragColor.r = pow(fragColor.r, uGamma);
  fragColor.g = pow(fragColor.g, uGamma);
  fragColor.b = pow(fragColor.b, uGamma);
  // apply fog (particles keep alpha)
  vec3 finalRgb = mix(uFogColor, fragColor.rgb, vFog);
  fragColor = vec4(finalRgb, fragColor.a);
  fragEmissive = vec4(0.0);
}
