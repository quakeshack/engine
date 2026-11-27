#version 300 es
precision highp float;
precision highp sampler2D;
precision highp sampler2DShadow;
precision highp samplerCubeShadow;

layout(location = 0) out vec4 fragColor;
layout(location = 1) out vec4 fragEmissive;

uniform float uGamma;
uniform sampler2D tTexture;
uniform sampler2D tGlow;
uniform sampler2D tShirt;
uniform sampler2D tPants;
// Shirt and pants colors in 0 to 1. Black for an entity without player colors, which turns the masks off.
uniform vec3 uShirtColor;
uniform vec3 uPantsColor;
uniform float uAlpha;
uniform float uBloomEmissiveScale;

#include "entity-lighting.glsl"
#include "fog-fragment.glsl"

// Specular highlight, fixed like the other entity programs: a skeletal model carries no specular map. Ambient light is
// excluded since it is non-directional and produces no highlight.
const float kSkeletalSpecularShininess = 24.0;
const float kSkeletalSpecularIntensity = 0.25;

void main(void) {
  // Player colors the way DarkPlaces does them: the shirt and pants masks are greyscale companions of the base image
  // and are ADDED, scaled by the color, so the base image has those pixels blanked. (The alias player program mixes
  // by a mask instead; a mix would show the blanked base through.)
  vec3 baseColor = texture(tTexture, vTexCoord).rgb
                 + texture(tShirt, vTexCoord).rgb * uShirtColor
                 + texture(tPants, vTexCoord).rgb * uPantsColor;
  vec3 glow = texture(tGlow, vTexCoord).rgb;

  vec3 lighting;
  vec3 specular;
  computeEntityLighting(kSkeletalSpecularShininess, kSkeletalSpecularIntensity, lighting, specular);

  // The glow is added after lighting, so it stays visible in the dark.
  vec3 litColor = baseColor * lighting + specular + glow;

  fragColor = vec4(pow(litColor, vec3(uGamma)), uAlpha);
  // apply fog
  vec3 finalRgb = mix(uFogColor, fragColor.rgb, vFog);
  fragColor = vec4(finalRgb, fragColor.a);

  // Only the glow and the entity's own emissive scale feed the bloom pass.
  vec3 emissiveColor = pow(glow + baseColor * uBloomEmissiveScale, vec3(uGamma));
  emissiveColor = mix(uFogColor, emissiveColor, vFog);
  fragEmissive = vec4(emissiveColor, fragColor.a);
}
