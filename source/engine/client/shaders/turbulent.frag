#version 300 es
precision highp float;
precision highp sampler2D;
precision highp sampler2DArray;

layout(location = 0) out vec4 fragColor;
layout(location = 1) out vec4 fragEmissive;

uniform float uGamma;
uniform float uTime;
uniform float uInterpolation;
uniform float uLightstyleInterpolation;
uniform float uAlpha;
uniform float uBloomEmissiveScale;
uniform float uBloomDlightScale;
uniform sampler2D tTexture;
uniform sampler2D tLuminance;
uniform sampler2DArray tLightmap;
uniform sampler2D tDlight;
uniform sampler2D tLightStyleA;
uniform sampler2D tLightStyleB;

in vec4 vTexCoord;
in vec4 vLightStyle;
in float vFog;
in vec3 vFallbackLight;
in vec2 vDlightTexCoord;
in float vHasLightmap;
uniform vec3 uFogColor;

void main(void) {
  vec2 warpedTexCoord = vTexCoord.st + vec2(sin(vTexCoord.t * 3.141593 + uTime), sin(vTexCoord.s * 3.141593 + uTime)) * 0.125;
  vec4 texel = vec4(texture(tTexture, warpedTexCoord).rgb, 1.0);
  vec3 luminance = texture(tLuminance, warpedTexCoord).rgb;

  vec4 lightstyleA = vec4(
    texture(tLightStyleA, vec2(vLightStyle.x, 0.0)).r,
    texture(tLightStyleA, vec2(vLightStyle.y, 0.0)).r,
    texture(tLightStyleA, vec2(vLightStyle.z, 0.0)).r,
    texture(tLightStyleA, vec2(vLightStyle.w, 0.0)).r
  );
  vec4 lightstyleB = vec4(
    texture(tLightStyleB, vec2(vLightStyle.x, 0.0)).r,
    texture(tLightStyleB, vec2(vLightStyle.y, 0.0)).r,
    texture(tLightStyleB, vec2(vLightStyle.z, 0.0)).r,
    texture(tLightStyleB, vec2(vLightStyle.w, 0.0)).r
  );

  vec4 scaledLightstyle = mix(lightstyleA, lightstyleB, uLightstyleInterpolation) * 43.828125;

  vec3 d = mix(
    vFallbackLight,
    vec3(
      dot(texture(tLightmap, vec3(vTexCoord.zw, 0.0)), scaledLightstyle),
      dot(texture(tLightmap, vec3(vTexCoord.zw, 1.0)), scaledLightstyle),
      dot(texture(tLightmap, vec3(vTexCoord.zw, 2.0)), scaledLightstyle)
    ),
    step(0.5, vHasLightmap)
  );

  vec3 dlight = texture(tDlight, vDlightTexCoord).rgb;

  vec3 emissiveColor = texel.rgb * clamp(luminance + vec3(uBloomEmissiveScale), 0.0, 1.0);

  fragColor = vec4(texel.rgb * mix(vec3(1.0), d + dlight, texel.a), uAlpha);
  // apply fog (mix RGB only, preserve alpha)
  vec3 finalRgb = fragColor.rgb + emissiveColor;
  finalRgb = mix(uFogColor, finalRgb, vFog);
  fragColor = vec4(finalRgb, fragColor.a);

  emissiveColor += texel.rgb * dlight * uBloomDlightScale;
  vec3 bloomEmissive = pow(emissiveColor, vec3(uGamma));
  bloomEmissive = mix(uFogColor, bloomEmissive, vFog);
  fragEmissive = vec4(bloomEmissive, uAlpha);
}
