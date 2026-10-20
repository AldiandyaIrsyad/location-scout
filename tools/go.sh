#!/usr/bin/env sh
# Run any Go command inside the official golang container (no local Go install needed).
# Usage: tools/go.sh test ./...     tools/go.sh build ./...     tools/go.sh run ./cmd/server
# Module and build caches persist in the named Docker volumes gomodcache / gobuildcache.
set -e
# pwd -W gives a Windows path under Git Bash (Docker Desktop needs it); plain pwd elsewhere.
ROOT="$(cd "$(dirname "$0")/.." && { pwd -W 2>/dev/null || pwd; })"
IMAGE="${GO_IMAGE:-golang:1.24-alpine}"
MSYS_NO_PATHCONV=1 exec docker run --rm ${GO_DOCKER_ARGS:-} \
  -v "$ROOT:/src" -v gomodcache:/go/pkg/mod -v gobuildcache:/root/.cache/go-build \
  -w /src -e CGO_ENABLED=0 "$IMAGE" go "$@"
