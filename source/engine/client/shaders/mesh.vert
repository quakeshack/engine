#version 300 es
precision highp float;

in vec3 aPosition;
in vec2 aTexCoord;
in vec3 aNormal;

#include "entity-vertex.glsl"

void main(void) {
  emitEntityVertex(aPosition, aNormal, aTexCoord);
}
