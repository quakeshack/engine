// Fragment inputs shared by the lit entity programs (alias, mesh, player), matched by entity-varyings-out.glsl.
// vWorldPos comes from shadow-entity.glsl, vFog from fog-fragment.glsl.
in vec2 vTexCoord;
in float vLightDot;
in float vDynamicLightDot;
in vec4 vShadowCoord;
in vec3 vNormal;
in vec3 vLightVec;
in vec3 vDynamicLightVec;
in vec3 vViewVec;
