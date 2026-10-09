// Vertex outputs shared by the lit entity programs (alias, mesh, player), matched by entity-varyings-in.glsl.
// vFog comes from fog-vertex.glsl.
out vec2 vTexCoord;
out float vLightDot;
out float vDynamicLightDot;
out vec4 vShadowCoord;
out vec3 vWorldPos;
out vec3 vNormal;
out vec3 vLightVec;
out vec3 vDynamicLightVec;
out vec3 vViewVec;
