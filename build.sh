#!/usr/bin/env bash

GIT_COMMIT_SHA="$(git rev-parse --short=8 HEAD || echo "unknown")"

echo "Building Docker image with commit SHA: $GIT_COMMIT_SHA"

docker build --build-arg "GIT_COMMIT_SHA=$GIT_COMMIT_SHA" -t "quakeshack:$GIT_COMMIT_SHA" .

docker tag "quakeshack:$GIT_COMMIT_SHA" quakeshack:latest

echo "Docker image built and tagged:"
echo "  quakeshack:$GIT_COMMIT_SHA"
echo "  quakeshack:latest"
