#version 300 es
precision highp float;
precision highp sampler2D;
precision highp sampler2DShadow;
precision highp samplerCubeShadow;

layout(location = 0) out vec4 fragColor;
layout(location = 1) out vec4 fragEmissive;

uniform float uGamma;
uniform float uTime;
uniform sampler2D tTexture;
uniform sampler2D tLuminance;
uniform float uAlpha;
uniform float uBloomEmissiveScale;

#include "entity-lighting.glsl"
#include "fog-fragment.glsl"

// Specular highlight for alias models — MDL models carry no per-texel
// specular map, so intensity/shininess are fixed, tuned for a subtle,
// non-metallic highlight rather than a per-material property. Ambient light
// is intentionally excluded since it is non-directional and produces no
// highlight.
const float kAliasSpecularShininess = 64.0;
const float kAliasSpecularIntensity = 0.125;

void main(void){
  vec4 texel = texture(tTexture, vTexCoord);
  vec3 luminance = texture(tLuminance, vTexCoord).rgb;

  vec3 lighting;
  vec3 specular;
  computeEntityLighting(kAliasSpecularShininess, kAliasSpecularIntensity, lighting, specular);

  fragColor = vec4(texel.rgb * mix(vec3(1.0), lighting, texel.a) + specular * texel.a, uAlpha);
  fragColor.rgb = pow(fragColor.rgb, vec3(uGamma));
  // apply fog
  vec3 finalRgb = mix(uFogColor, fragColor.rgb, vFog);
  fragColor = vec4(finalRgb, fragColor.a);
  vec3 emissiveColor = texel.rgb * clamp(luminance + vec3(uBloomEmissiveScale), 0.0, 1.0);
  emissiveColor = pow(emissiveColor, vec3(uGamma));
  emissiveColor = mix(uFogColor, emissiveColor, vFog);
  fragEmissive = vec4(emissiveColor, fragColor.a);
}
