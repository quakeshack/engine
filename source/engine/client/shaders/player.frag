#version 300 es
precision highp float;
precision highp sampler2D;
precision highp sampler2DShadow;
precision highp samplerCubeShadow;

layout(location = 0) out vec4 fragColor;
layout(location = 1) out vec4 fragEmissive;

uniform float uGamma;
uniform float uTime;
uniform vec3 uTop;
uniform vec3 uBottom;
uniform sampler2D tTexture;
uniform sampler2D tLuminance;
uniform sampler2D tPlayer;
uniform float uAlpha;
uniform float uBloomEmissiveScale;

#include "entity-lighting.glsl"
#include "fog-fragment.glsl"

// Specular highlight for the player model — no per-texel specular map exists
// here, so intensity/shininess are fixed, tuned for a subtle, non-metallic
// highlight rather than a per-material property. Ambient light is
// intentionally excluded since it is non-directional and produces no
// highlight.
const float kPlayerSpecularShininess = 24.0;
const float kPlayerSpecularIntensity = 0.25;

void main(void) {
  vec4 texel = texture(tTexture, vTexCoord);
  vec3 luminance = texture(tLuminance, vTexCoord).rgb;
  vec4 player = texture(tPlayer, vTexCoord);

  vec3 lighting;
  vec3 specular;
  computeEntityLighting(kPlayerSpecularShininess, kPlayerSpecularIntensity, lighting, specular);

  vec3 baseColor = mix(mix(texel.rgb, uTop * ((1.0 / 191.25) * player.x), player.y), uBottom * ((1.0 / 191.25) * player.z), player.w);

  fragColor = vec4(baseColor * mix(vec3(1.0), lighting, texel.a) + specular * texel.a, texel.a);
  fragColor.rgb = pow(fragColor.rgb, vec3(uGamma));
  // apply fog
  vec3 finalRgb = mix(uFogColor, fragColor.rgb, vFog);
  fragColor = vec4(finalRgb, fragColor.a * uAlpha);
  vec3 emissiveColor = baseColor * clamp(luminance + vec3(uBloomEmissiveScale), 0.0, 1.0);
  emissiveColor = pow(emissiveColor, vec3(uGamma));
  emissiveColor = mix(uFogColor, emissiveColor, vFog);
  fragEmissive = vec4(emissiveColor, fragColor.a);
}

