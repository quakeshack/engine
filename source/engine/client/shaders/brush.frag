#version 300 es
precision highp float;
precision highp sampler2D;
precision highp sampler2DArray;
precision highp sampler2DShadow;
precision highp samplerCube;
precision highp samplerCubeShadow;

out vec4 fragColor;

uniform float uGamma;
uniform float uInterpolation;
uniform float uAlpha;

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

// Shadow mapping
uniform sampler2DShadow tShadowMap0;
uniform sampler2DShadow tShadowMap1;
uniform sampler2DShadow tShadowMap2;
uniform float uShadowEnabled;
uniform int uShadowCount;
uniform float uShadowDarkness;
uniform float uShadowMapSize;

// Point light shadow mapping
uniform samplerCubeShadow tPointShadowMap;
uniform vec3 uPointLightPos;
uniform float uPointLightRadius;
uniform float uPointShadowEnabled;

uniform bool uPerformDotLighting;
uniform bool uHaveDeluxemap;

uniform vec3 uAmbientLight;
uniform vec3 uShadeLight;
uniform vec3 uDynamicShadeLight;

in vec4 vTexCoord;
in vec4 vLightStyle;
in float vLightDot;
in float vDynamicLightDot;
in float vFog;
in vec3 vNormal;
in vec3 vLightVec;
in vec3 vDynamicLightVec;
in vec3 vTangent;
in vec3 vBitangent;
in vec3 vViewVec;
in vec4 vShadowCoord0;
in vec4 vShadowCoord1;
in vec4 vShadowCoord2;
in vec3 vWorldPos;
uniform vec3 uFogColor;
in mat3 vAngles;

float sampleLocalShadowPCF(sampler2DShadow shadowMap, vec4 shadowCoordH) {
  vec3 shadowCoord = shadowCoordH.xyz / shadowCoordH.w * 0.5 + 0.5;
  if (shadowCoord.z < 0.0 || shadowCoord.z > 1.0) {
    return 1.0;
  }

  float edgeDist = max(abs(shadowCoord.x * 2.0 - 1.0), abs(shadowCoord.y * 2.0 - 1.0));
  float fade = 1.0 - smoothstep(0.7, 1.0, edgeDist);
  if (fade <= 0.0) {
    return 1.0;
  }

  float texelSize = 1.0 / uShadowMapSize;
  float lit = 0.0;
  lit += 1.0  * texture(shadowMap, shadowCoord + vec3(-2.0, -2.0, 0.0) * texelSize);
  lit += 4.0  * texture(shadowMap, shadowCoord + vec3(-1.0, -2.0, 0.0) * texelSize);
  lit += 6.0  * texture(shadowMap, shadowCoord + vec3( 0.0, -2.0, 0.0) * texelSize);
  lit += 4.0  * texture(shadowMap, shadowCoord + vec3( 1.0, -2.0, 0.0) * texelSize);
  lit += 1.0  * texture(shadowMap, shadowCoord + vec3( 2.0, -2.0, 0.0) * texelSize);
  lit += 4.0  * texture(shadowMap, shadowCoord + vec3(-2.0, -1.0, 0.0) * texelSize);
  lit += 16.0 * texture(shadowMap, shadowCoord + vec3(-1.0, -1.0, 0.0) * texelSize);
  lit += 24.0 * texture(shadowMap, shadowCoord + vec3( 0.0, -1.0, 0.0) * texelSize);
  lit += 16.0 * texture(shadowMap, shadowCoord + vec3( 1.0, -1.0, 0.0) * texelSize);
  lit += 4.0  * texture(shadowMap, shadowCoord + vec3( 2.0, -1.0, 0.0) * texelSize);
  lit += 6.0  * texture(shadowMap, shadowCoord + vec3(-2.0,  0.0, 0.0) * texelSize);
  lit += 24.0 * texture(shadowMap, shadowCoord + vec3(-1.0,  0.0, 0.0) * texelSize);
  lit += 36.0 * texture(shadowMap, shadowCoord + vec3( 0.0,  0.0, 0.0) * texelSize);
  lit += 24.0 * texture(shadowMap, shadowCoord + vec3( 1.0,  0.0, 0.0) * texelSize);
  lit += 6.0  * texture(shadowMap, shadowCoord + vec3( 2.0,  0.0, 0.0) * texelSize);
  lit += 4.0  * texture(shadowMap, shadowCoord + vec3(-2.0,  1.0, 0.0) * texelSize);
  lit += 16.0 * texture(shadowMap, shadowCoord + vec3(-1.0,  1.0, 0.0) * texelSize);
  lit += 24.0 * texture(shadowMap, shadowCoord + vec3( 0.0,  1.0, 0.0) * texelSize);
  lit += 16.0 * texture(shadowMap, shadowCoord + vec3( 1.0,  1.0, 0.0) * texelSize);
  lit += 4.0  * texture(shadowMap, shadowCoord + vec3( 2.0,  1.0, 0.0) * texelSize);
  lit += 1.0  * texture(shadowMap, shadowCoord + vec3(-2.0,  2.0, 0.0) * texelSize);
  lit += 4.0  * texture(shadowMap, shadowCoord + vec3(-1.0,  2.0, 0.0) * texelSize);
  lit += 6.0  * texture(shadowMap, shadowCoord + vec3( 0.0,  2.0, 0.0) * texelSize);
  lit += 4.0  * texture(shadowMap, shadowCoord + vec3( 1.0,  2.0, 0.0) * texelSize);
  lit += 1.0  * texture(shadowMap, shadowCoord + vec3( 2.0,  2.0, 0.0) * texelSize);
  lit /= 256.0;

  return mix(1.0, mix(uShadowDarkness, 1.0, lit), fade);
}

void main(void) {
  // Combine texture samples at the start
  vec4 textureA = texture(tTextureA, vTexCoord.xy);
  vec4 textureB = texture(tTextureB, vTexCoord.xy);
  vec4 luminance = texture(tLuminance, vTexCoord.xy);

  // interpolation
  vec4 texel = mix(textureA, textureB, uInterpolation);

  // Pre-calculate lightstyle constant
  const float LIGHTSTYLE_SCALE = 43.828125;

  // Optimize lightstyle sampling - use texture lookups more efficiently
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
  vec4 lightstyle = mix(lightstyleA, lightstyleB, uInterpolation) * LIGHTSTYLE_SCALE;

  // Sample lightmap layers (R, G, B each in a separate array layer)
  vec4 lightmapR = texture(tLightmap, vec3(vTexCoord.zw, 0.0));
  vec4 lightmapG = texture(tLightmap, vec3(vTexCoord.zw, 1.0));
  vec4 lightmapB = texture(tLightmap, vec3(vTexCoord.zw, 2.0));

  vec3 lightmap = vec3(
    dot(lightmapR, lightstyle),
    dot(lightmapG, lightstyle),
    dot(lightmapB, lightstyle)
  );

  // Local entity shadow — small local depth map, BSP-light-driven direction.
  // Modulates the lightmap; fades smoothly to fully-lit at coverage edge.
  // 5×5 Gaussian-weighted PCF for smooth shadow edges. Each tap uses the
  // hardware sampler2DShadow (LINEAR gives free 2×2 PCF per tap).
  float shadow = 1.0;
  if (uShadowEnabled > 0.5 && uShadowCount > 0) {
    shadow = sampleLocalShadowPCF(tShadowMap0, vShadowCoord0);
    if (uShadowCount > 1) {
      shadow = min(shadow, sampleLocalShadowPCF(tShadowMap1, vShadowCoord1));
    }
    if (uShadowCount > 2) {
      shadow = min(shadow, sampleLocalShadowPCF(tShadowMap2, vShadowCoord2));
    }
  }

  // Point light shadow — entity shadows cast from the nearest point light
  // (BSP light entity or transient dynamic light). Fades quickly with
  // distance so the effect is localised around the light source.
  float pointShadow = 1.0;
  if (uPointShadowEnabled > 0.5) {
    vec3 fragToLight = vWorldPos - uPointLightPos;
    float fragDist = length(fragToLight);
    if (fragDist < uPointLightRadius) {
      // The cubemap face's perspective projection stores depth based on
      // the view-space Z, which equals the dominant axis of fragToLight
      // (the component that selected this cube face). Using the radial
      // distance instead would overestimate depth at face edges/corners,
      // producing a cross-shaped shadow artifact at cube face seams.
      vec3 absFTL = abs(fragToLight);
      float viewZ = max(absFTL.x, max(absFTL.y, absFTL.z));
      float n = 1.0;
      float f = uPointLightRadius;
      float refDepth = (n * f / (n - f)) / viewZ + n / (n - f);
      refDepth = refDepth * 0.5 + 0.5;
      float cubeShadow = texture(tPointShadowMap, vec4(fragToLight, refDepth));
      // Quick distance fade — shadow strongest near the light, gone
      // well before the radius edge so coverage stays tight.
      float ptFade = 1.0 - smoothstep(f * 0.3, f * 0.7, fragDist);
      pointShadow = mix(1.0, cubeShadow, ptFade);
    }
  }

  // Point shadow darkens the lightmap (with a darkness floor so it never
  // goes pure black) and fully occludes the dynamic light contribution.
  vec3 staticLight = lightmap * shadow * mix(uShadowDarkness, 1.0, pointShadow)
                   + texture(tDlight, vTexCoord.zw).rgb * pointShadow;

  float bumpLightDot = 1.0;
  float specFactor = 0.0;
  float lightFactor = 1.0;

  if (uPerformDotLighting) {
    float dynamicStrength = clamp(max(uDynamicShadeLight.r, max(uDynamicShadeLight.g, uDynamicShadeLight.b)), 0.0, 1.0);
    vec3 lightDirection;

    if (uHaveDeluxemap) {
      // Reuse pre-calculated deluxemap coordinates
      vec4 deluxemapR = texture(tDeluxemap, vec3(vTexCoord.zw, 0.0));
      vec4 deluxemapG = texture(tDeluxemap, vec3(vTexCoord.zw, 1.0));
      vec4 deluxemapB = texture(tDeluxemap, vec3(vTexCoord.zw, 2.0));

      lightDirection = vec3(
        dot(deluxemapR, lightstyle),
        dot(deluxemapG, lightstyle),
        dot(deluxemapB, lightstyle)
      );

      lightDirection.x *= vNormal.x >= 0.0 ? 1.0 : -1.0;
      lightDirection.y *= vNormal.y >= 0.0 ? 1.0 : -1.0;

      // need to adjust for rotation of the surface
      lightDirection *= vAngles;
    } else {
      // fallback to what the vertex shader has for us
      lightDirection = vLightVec;
    }

    // Sample normal and specular maps once
    vec3 normalPoint = texture(tNormal, vTexCoord.xy).xyz;
    float specIntensity = texture(tSpecular, vTexCoord.xy).r;

    // Convert normal from [0,1] to [-1,1] and invert X,Y in one operation
    vec3 normalMap = normalize(vec3(
      -(normalPoint.x * 2.0 - 1.0),
      -(normalPoint.y * 2.0 - 1.0),
      normalPoint.z * 2.0 - 1.0
    ));

    // Gram-Schmidt orthogonalize tangent against normal (inline to avoid extra variables)
    vec3 t = normalize(vTangent - vNormal * dot(vNormal, vTangent));
    vec3 b = normalize(vBitangent - vNormal * dot(vNormal, vBitangent) - t * dot(t, vBitangent));

    // Build TBN transform and apply to normal
    vec3 N = normalize(t * normalMap.x + b * normalMap.y + vNormal * normalMap.z);
    vec3 L = normalize(lightDirection);
    vec3 V = normalize(vViewVec);

    // Calculate lighting (removed duplicate lightFactor assignment)
    lightFactor = max(dot(N, L), 0.0);
    vec3 H = normalize(L + V);
    specFactor = specIntensity * pow(max(dot(N, H), 0.0), 16.0);

    // Add dynamic light contribution
    float dynLightDot = max(dot(N, vDynamicLightVec), 0.0) * dynamicStrength;
    vec3 dynH = normalize(vDynamicLightVec + V);
    float dynSpecFactor = specIntensity * pow(max(dot(N, dynH), 0.0), 16.0) * dynamicStrength;

    // Combine both light sources
    lightFactor += dynLightDot;
    specFactor += dynSpecFactor;
  }

  // Calculate bump mapping factor - blend between full lighting and bump-modified lighting
  // This prevents completely black surfaces while still allowing bump mapping to have effect
  const float minAmbient = 0.5;
  float bumpFactor = minAmbient + (1.0 - minAmbient) * pow(lightFactor, 0.7);

  // Pre-calculate common factors to avoid redundant calculations
  vec3 shadeAmbient = vLightDot * uShadeLight + uAmbientLight + vDynamicLightDot * uDynamicShadeLight;
  vec3 lightingFactor = staticLight * bumpFactor * shadeAmbient;
  vec3 luminanceMask = texel.a * (vec3(1.0) - luminance.rgb);

  // Combine lighting in one operation per channel
  vec3 finalColor = texel.rgb * mix(vec3(1.0), lightingFactor, luminanceMask) + specFactor * staticLight;

  // Apply gamma correction using pow on vec3 (single operation instead of 3)
  finalColor = pow(finalColor, vec3(uGamma));

  // Apply fog
  finalColor = mix(uFogColor, finalColor, vFog);

  fragColor = vec4(finalColor, texel.a * uAlpha);
}
