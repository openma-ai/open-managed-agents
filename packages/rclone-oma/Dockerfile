# Build contract for the pinned gateway remote. The E2B/Work image can copy
# /usr/local/bin/rclone-oma from this stage into its existing worker image.
FROM golang:1.25.4-bookworm AS build

ARG TARGETOS=linux
ARG TARGETARCH=amd64

WORKDIR /src
COPY packages/rclone-oma/go.mod packages/rclone-oma/go.sum ./
RUN go mod download
COPY packages/rclone-oma/backend ./backend
COPY packages/rclone-oma/cmd ./cmd
RUN CGO_ENABLED=0 GOOS="$TARGETOS" GOARCH="$TARGETARCH" go build -buildvcs=false -trimpath -ldflags='-s -w' -o /out/rclone-oma ./cmd/rclone-oma

FROM debian:bookworm-slim

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends fuse3 ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/rclone-oma /usr/local/bin/rclone-oma

ENTRYPOINT ["/usr/local/bin/rclone-oma"]
