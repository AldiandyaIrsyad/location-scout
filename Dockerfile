# syntax=docker/dockerfile:1

# Build stage: a static binary (no cgo), stripped and trimmed.
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/server ./cmd/server \
 && mkdir -p /out/data/cache \
 && chown -R 65532:65532 /out/data

# Runtime stage: no shell and no package manager. Runs as the non-root user 65532.
FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=build /out/server /app/server
# Recorded responses for the built-in places (see cmd/snapshot); SNAPSHOT_DIR defaults to ./snapshots, i.e. /app/snapshots.
COPY --from=build /src/snapshots /app/snapshots
# The cache directory must be writable by the non-root user (the named volume inherits this owner).
COPY --from=build --chown=65532:65532 /out/data /data
ENV CACHE_DIR=/data/cache \
    ADDR=:8080
USER 65532:65532
EXPOSE 8080
VOLUME /data
ENTRYPOINT ["/app/server"]
