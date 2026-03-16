#version 300 es
precision highp float;

out vec4 fragColor;

uniform float uAlpha;
uniform float uGamma;
uniform sampler2D tTexture;

in vec2 vTexCoord;
in float vFog;
uniform vec3 uFogColor;

void main(void) {
  fragColor = texture(tTexture, vTexCoord);
  fragColor.r = pow(fragColor.r, uGamma);
  fragColor.g = pow(fragColor.g, uGamma);
  fragColor.b = pow(fragColor.b, uGamma);
  if (fragColor.a < 0.25) discard;
  fragColor.a = fragColor.a * uAlpha;
  // apply fog
  vec3 finalRgb = mix(uFogColor, fragColor.rgb, vFog);
  fragColor = vec4(finalRgb, fragColor.a);
}
