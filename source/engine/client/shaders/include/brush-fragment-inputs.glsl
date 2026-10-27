// The uniforms and inputs of the fragment stage of the brush programs (`brush`, `brush-refract`), the counterpart of
// brush-vertex.glsl. The shadow maps are not here: only `brush` samples them.
uniform float uGamma;
uniform float uInterpolation;
uniform float uLightstyleInterpolation;
uniform float uAlpha;
uniform float uBloomEmissiveScale;
uniform float uBloomDlightScale;
uniform float uBloomSpecularScale;

uniform sampler2D tTextureA;
uniform sampler2D tTextureB;
uniform sampler2DArray tLightmap;
uniform sampler2D tDlight;
uniform sampler2D tLightStyleA;
uniform sampler2D tLightStyleB;
uniform sampler2D tLuminance;
uniform sampler2D tNormal;
uniform sampler2D tSpecular;
uniform sampler2DArray tDeluxemap;

// The point lights that may cast shadows (see ShadowMap.selectPointLights()): their light is not in the baked
// dlight texture, each program adds it itself.
uniform vec3 uPointLightPos0;
uniform vec3 uPointLightPos1;
uniform vec3 uPointLightPos2;
uniform float uPointLightRadius0;
uniform float uPointLightRadius1;
uniform float uPointLightRadius2;
uniform vec3 uPointLightColor0;
uniform vec3 uPointLightColor1;
uniform vec3 uPointLightColor2;

uniform bool uPerformDotLighting;
uniform bool uHaveDeluxemap;

uniform vec3 uAmbientLight;
uniform vec3 uShadeLight;
uniform vec3 uDynamicShadeLight;

in vec4 vTexCoord;
in vec4 vLightStyle;
in float vLightDot;
in float vDynamicLightDot;
#include "fog-fragment.glsl"
in vec3 vNormal;
in vec3 vLightVec;
in vec3 vDynamicLightVec;
in vec3 vTangent;
in vec3 vBitangent;
in vec3 vViewVec;
in vec4 vShadowCoord;
in vec3 vWorldPos;
