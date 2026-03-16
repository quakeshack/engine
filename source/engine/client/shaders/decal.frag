#version 300 es
precision highp float;

out vec4 fragColor;

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
  fragColor.r = pow(fragColor.r, uGamma);
  fragColor.g = pow(fragColor.g, uGamma);
  fragColor.b = pow(fragColor.b, uGamma);

  if (fragColor.a < 0.01) discard;

  // apply fog
  vec3 finalRgb = mix(uFogColor, fragColor.rgb, vFog);
  fragColor = vec4(finalRgb, fragColor.a);
}
