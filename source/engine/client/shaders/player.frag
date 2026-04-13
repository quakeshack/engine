#version 300 es
precision highp float;
precision highp sampler2D;
precision highp sampler2DShadow;
precision highp samplerCubeShadow;

layout(location = 0) out vec4 fragColor;
layout(location = 1) out vec4 fragEmissive;

uniform float uGamma;
uniform vec3 uAmbientLight;
uniform vec3 uShadeLight;
uniform vec3 uDynamicShadeLight;
uniform float uTime;
uniform vec3 uTop;
uniform vec3 uBottom;
uniform sampler2D tTexture;
uniform sampler2D tLuminance;
uniform sampler2D tPlayer;
uniform float uAlpha;
uniform float uBloomEmissiveScale;

// Shadow mapping
uniform sampler2DShadow tShadowMap0;
uniform sampler2DShadow tShadowMap1;
uniform sampler2DShadow tShadowMap2;
uniform float uShadowEnabled;
uniform int uShadowCount;
uniform float uShadowDarkness;

// Point light shadow mapping
uniform samplerCubeShadow tPointShadowMap;
uniform vec3 uPointLightPos;
uniform float uPointLightRadius;
uniform float uPointShadowEnabled;

in vec2 vTexCoord;
in float vLightDot;
in float vDynamicLightDot;
in float vFog;
in vec4 vShadowCoord0;
in vec4 vShadowCoord1;
in vec4 vShadowCoord2;
in vec3 vWorldPos;
uniform vec3 uFogColor;

float sampleLocalShadow(sampler2DShadow shadowMap, vec4 shadowCoordH) {
  vec3 shadowCoord = shadowCoordH.xyz / shadowCoordH.w * 0.5 + 0.5;
  float zValid = step(0.0, shadowCoord.z) * step(shadowCoord.z, 1.0);

  float edgeDist = max(abs(shadowCoord.x * 2.0 - 1.0), abs(shadowCoord.y * 2.0 - 1.0));
  float fade = (1.0 - smoothstep(0.7, 1.0, edgeDist)) * zValid;

  float rawShadow = texture(shadowMap, shadowCoord);
  return mix(1.0, mix(uShadowDarkness, 1.0, rawShadow), fade);
}

void main(void) {
  vec4 texel = texture(tTexture, vTexCoord);
  vec3 luminance = texture(tLuminance, vTexCoord).rgb;
  vec4 player = texture(tPlayer, vTexCoord);

  // Local entity shadow — small local depth map, BSP-light-driven direction.
  // Fades smoothly to fully-lit at the coverage edge (no hard clip).
  float s0 = sampleLocalShadow(tShadowMap0, vShadowCoord0);
  float s1 = sampleLocalShadow(tShadowMap1, vShadowCoord1);
  float s2 = sampleLocalShadow(tShadowMap2, vShadowCoord2);

  float shadow = mix(1.0, s0, step(1.0, float(uShadowCount)));
  shadow = mix(shadow, min(s0, s1), step(2.0, float(uShadowCount)));
  shadow = mix(shadow, min(min(s0, s1), s2), step(3.0, float(uShadowCount)));
  shadow = mix(1.0, shadow, step(0.5, uShadowEnabled));

  // Point light shadow
  vec3 fragToLight = vWorldPos - uPointLightPos;
  float fragDist = length(fragToLight);
  vec3 absFTL = abs(fragToLight);
  float viewZ = max(absFTL.x, max(absFTL.y, absFTL.z));
  float n = 1.0;
  float f = uPointLightRadius;
  float refDepth = (n * f / (n - f)) / viewZ + n / (n - f);
  refDepth = refDepth * 0.5 + 0.5;
  float cubeShadow = texture(tPointShadowMap, vec4(fragToLight, refDepth));

  float pointShadow = mix(1.0, cubeShadow, step(fragDist, f) * step(0.5, uPointShadowEnabled));

  vec3 lighting = (vLightDot * uShadeLight + uAmbientLight + vDynamicLightDot * uDynamicShadeLight * pointShadow) * shadow;

  vec3 baseColor = mix(mix(texel.rgb, uTop * ((1.0 / 191.25) * player.x), player.y), uBottom * ((1.0 / 191.25) * player.z), player.w);

  fragColor = vec4(baseColor * mix(vec3(1.0), lighting, texel.a), texel.a);
  fragColor.rgb = pow(fragColor.rgb, vec3(uGamma));
  // apply fog
  vec3 finalRgb = mix(uFogColor, fragColor.rgb, vFog);
  fragColor = vec4(finalRgb, fragColor.a * uAlpha);
  vec3 emissiveColor = baseColor * clamp(luminance + vec3(uBloomEmissiveScale), 0.0, 1.0);
  emissiveColor = pow(emissiveColor, vec3(uGamma));
  emissiveColor = mix(uFogColor, emissiveColor, vFog);
  fragEmissive = vec4(emissiveColor, fragColor.a);
}

