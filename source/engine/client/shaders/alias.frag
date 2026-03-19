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
uniform sampler2D tTexture;
uniform sampler2D tLuminance;
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
  if (shadowCoord.z < 0.0 || shadowCoord.z > 1.0) {
    return 1.0;
  }

  float edgeDist = max(abs(shadowCoord.x * 2.0 - 1.0), abs(shadowCoord.y * 2.0 - 1.0));
  float fade = 1.0 - smoothstep(0.7, 1.0, edgeDist);
  if (fade <= 0.0) {
    return 1.0;
  }

  float lit = texture(shadowMap, shadowCoord);
  return mix(1.0, mix(uShadowDarkness, 1.0, lit), fade);
}

void main(void){
  vec4 texel = texture(tTexture, vTexCoord);
  vec3 luminance = texture(tLuminance, vTexCoord).rgb;

  // Local entity shadow — small local depth map, BSP-light-driven direction.
  // Fades smoothly to fully-lit at the coverage edge (no hard clip).
  // sampler2DShadow + LINEAR gives free 2×2 PCF soft edges.
  float shadow = 1.0;
  if (uShadowEnabled > 0.5 && uShadowCount > 0) {
    shadow = sampleLocalShadow(tShadowMap0, vShadowCoord0);
    if (uShadowCount > 1) {
      shadow = min(shadow, sampleLocalShadow(tShadowMap1, vShadowCoord1));
    }
    if (uShadowCount > 2) {
      shadow = min(shadow, sampleLocalShadow(tShadowMap2, vShadowCoord2));
    }
  }

  // Point light shadow — entity shadows from nearest BSP / dynamic light.
  // Quick distance fade keeps the effect tight around the source.
  float pointShadow = 1.0;
  if (uPointShadowEnabled > 0.5) {
    vec3 fragToLight = vWorldPos - uPointLightPos;
    float fragDist = length(fragToLight);
    if (fragDist < uPointLightRadius) {
      vec3 absFTL = abs(fragToLight);
      float viewZ = max(absFTL.x, max(absFTL.y, absFTL.z));
      float n = 1.0;
      float f = uPointLightRadius;
      float refDepth = (n * f / (n - f)) / viewZ + n / (n - f);
      refDepth = refDepth * 0.5 + 0.5;
      float cubeShadow = texture(tPointShadowMap, vec4(fragToLight, refDepth));
      float ptFade = 1.0 - smoothstep(f * 0.3, f * 0.7, fragDist);
      pointShadow = mix(1.0, cubeShadow, ptFade);
    }
  }

  float pointLM = mix(uShadowDarkness, 1.0, pointShadow);
  vec3 lighting = ((vLightDot * uShadeLight + uAmbientLight) * pointLM
                + vDynamicLightDot * uDynamicShadeLight * pointShadow) * shadow;

  fragColor = vec4(
    texel.r * mix(1.0, lighting.r, texel.a),
    texel.g * mix(1.0, lighting.g, texel.a),
    texel.b * mix(1.0, lighting.b, texel.a),
    uAlpha
  );
  fragColor.r = pow(fragColor.r, uGamma);
  fragColor.g = pow(fragColor.g, uGamma);
  fragColor.b = pow(fragColor.b, uGamma);
  // apply fog
  vec3 finalRgb = mix(uFogColor, fragColor.rgb, vFog);
  fragColor = vec4(finalRgb, fragColor.a);
  vec3 emissiveColor = texel.rgb * clamp(luminance + vec3(uBloomEmissiveScale), 0.0, 1.0);
  emissiveColor = pow(emissiveColor, vec3(uGamma));
  emissiveColor = mix(uFogColor, emissiveColor, vFog);
  fragEmissive = vec4(emissiveColor, fragColor.a);
}
