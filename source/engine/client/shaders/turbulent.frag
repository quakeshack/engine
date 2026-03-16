#version 300 es
precision highp float;
precision highp sampler2D;
precision highp sampler2DArray;

out vec4 fragColor;

uniform float uGamma;
uniform float uTime;
uniform float uAlpha;
uniform sampler2D tTexture;
uniform sampler2DArray tLightmap;
uniform sampler2D tDlight;
uniform sampler2D tLightStyle;

in vec4 vTexCoord;
in vec4 vLightStyle;
in float vFog;
in vec3 vFallbackLight;
in vec2 vDlightTexCoord;
in float vHasLightmap;
uniform vec3 uFogColor;

void main(void) {
  vec4 texel = vec4(texture(tTexture, vTexCoord.st + vec2(sin(vTexCoord.t * 3.141593 + uTime), sin(vTexCoord.s * 3.141593 + uTime)) * 0.125).rgb, 1.0);

  vec4 lightstyle = vec4(
    texture(tLightStyle, vec2(vLightStyle.x, 0.0)).r,
    texture(tLightStyle, vec2(vLightStyle.y, 0.0)).r,
    texture(tLightStyle, vec2(vLightStyle.z, 0.0)).r,
    texture(tLightStyle, vec2(vLightStyle.w, 0.0)).r
  );

  vec4 scaledLightstyle = lightstyle * 43.828125;
  bool hasLightmap = vHasLightmap > 0.5;

  vec3 d;
  if (hasLightmap) {
    d = vec3(
      dot(texture(tLightmap, vec3(vTexCoord.zw, 0.0)), scaledLightstyle),
      dot(texture(tLightmap, vec3(vTexCoord.zw, 1.0)), scaledLightstyle),
      dot(texture(tLightmap, vec3(vTexCoord.zw, 2.0)), scaledLightstyle)
    );
  } else {
    d = vFallbackLight;
  }

  vec3 dlight = texture(tDlight, vDlightTexCoord).rgb;

  fragColor = vec4(
    texel.r * mix(1.0, d.r + dlight.r, texel.a),
    texel.g * mix(1.0, d.g + dlight.g, texel.a),
    texel.b * mix(1.0, d.b + dlight.b, texel.a),
    uAlpha
  );
  // apply fog (mix RGB only, preserve alpha)
  vec3 finalRgb = fragColor.rgb;
  finalRgb = mix(uFogColor, finalRgb, vFog);
  fragColor = vec4(finalRgb, fragColor.a);
}
