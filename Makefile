# Panelscape. Go targets use the local toolchain when `go` is on PATH, otherwise tools/go.sh (Docker).
GO    := $(if $(shell command -v go 2>/dev/null),go,tools/go.sh)
BIN   := bin/server
IMAGE := panelscape
PORT  := 8080
PYTHON := $(if $(shell command -v python3 2>/dev/null),python3,python)

.PHONY: build run test vet fmt docker-build docker-run up down clean warm

build:
	@mkdir -p bin
	$(GO) build -trimpath -ldflags="-s -w" -o $(BIN) ./cmd/server

run:
	GO_DOCKER_ARGS="-p $(PORT):8080" $(GO) run ./cmd/server

test:
	$(GO) test ./...

vet:
	$(GO) vet ./...

fmt:
	$(GO) fmt ./...

docker-build:
	docker build -t $(IMAGE) .

docker-run: docker-build
	docker run --rm -p $(PORT):8080 -v panelscape-cache:/data $(IMAGE)

up:
	docker compose up -d --build

down:
	docker compose down

# Pre-fill the cache of a running server for every candidate place. Pass options with ARGS, e.g.
#   make warm ARGS="--group Japan --far 2,4"
warm:
	$(PYTHON) tools/warm_cache.py $(ARGS)

clean:
	rm -rf bin
