#version 300 es
precision highp float;
precision highp sampler2D;
precision highp sampler2DArray;

layout(location = 0) out vec4 fragColor;
layout(location = 1) out vec4 fragEmissive;

#include "brush-shading.glsl"
#include "refraction.glsl"

uniform sampler2D tDepth;
uniform vec2 uScreenSize;

// A translucent brush surface that refracts what is behind it (glass, a material with MF_REFRACT). It is shaded like
// `brush`, except that it receives no shadows: it lets the light through. The point lights still light it.
void main(void) {
  vec3 pointDlight = pointLightAttenuation(uPointLightPos0, uPointLightRadius0, uPointLightColor0)
                    + pointLightAttenuation(uPointLightPos1, uPointLightRadius1, uPointLightColor1)
                    + pointLightAttenuation(uPointLightPos2, uPointLightRadius2, uPointLightColor2);

  vec3 color;
  vec3 emissive;
  float alpha;
  shadeBrushSurface(1.0, pointDlight, color, emissive, alpha);

  // The normal map bends what is seen through the surface; a flat one (no map) bends nothing, like flat glass.
  vec2 distortion = texture(tNormal, vTexCoord.xy).xy * 2.0 - 1.0;
  vec2 screenUV = gl_FragCoord.xy / uScreenSize;
  vec2 behindUV = refractedScreenUV(tDepth, screenUV, distortion, linearizeDepth(gl_FragCoord.z));

  // the color replaces the pixel, the emissive is blended over the unshifted one behind, see refraction.glsl
  fragColor = composeRefraction(tSceneColor, behindUV, color, alpha);
  fragEmissive = vec4(emissive, alpha);
}
