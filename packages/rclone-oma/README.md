# OMA rclone remote

This directory is the source for the `oma` rclone remote used by a sandbox
native mount. It is intentionally built as a pinned rclone binary instead of
an unversioned plugin. The binary must be built against the same rclone
version as the sandbox image (`v1.74.1` today) and installed as
`/usr/local/bin/rclone-oma`.

The mount process receives only the current execution attempt's unified
`OPENMA_SANDBOX_TOKEN` through its process environment. The token is not a
rclone option, config value, command argument, file, or log field. The gateway
must verify the token and the requested root on every request. A token is a
capability for the current sandbox attempt, so rotating it invalidates the
old mount.

## Runtime contract

```sh
export OMA_GATEWAY_ENDPOINT=https://control.example
export OMA_SESSION_ID=session-id
export OPENMA_SANDBOX_TOKEN=oma_sbx_...
/usr/local/bin/rclone-oma mount :oma:memory/<store-id> /mnt/memory/store \
  --allow-other --vfs-cache-mode=writes
```

`OMA_GATEWAY_ENDPOINT`, `OMA_SESSION_ID`, and `OPENMA_SANDBOX_TOKEN` are read
by the backend at startup. The endpoint is a control-plane endpoint, not an
object-store URL. The backend sends `Authorization: Bearer <token>` and
`X-OMA-Storage-Protocol: 1` on every request. It never prints either value.

## Gateway contract

The main worker exposes the corresponding File API object route. The backend
and route share this deliberately narrow contract:

- `GET /v1/oma/storage/sessions/<session-id>/objects/<root>?prefix=<relative-dir>` returns
  `{"entries":[{"path":"name","is_dir":false,"size":1,"mod_time":"...","sha256":"..."}]}`.
- `HEAD /v1/oma/storage/sessions/<session-id>/objects/<root>/<path>` returns
  `X-OMA-Size`, `X-OMA-Mod-Time`, and optional `X-OMA-SHA256` headers.
- `GET`, `PUT`, `PATCH`, and `DELETE` on the object path stream, replace,
  update metadata, and remove an object. `PUT` receives `X-OMA-Mod-Time`.
- `POST` and `DELETE` on `/v1/oma/storage/sessions/<session-id>/objects/directories/<path>`
  create and remove directories.

The gateway owns path and access checks. The rclone process must not be given
parent S3 credentials or a second mount-specific token. The existing `:s3:`
path remains available for deployments that have not selected the OMA gateway.

## Build

From this directory, with Go installed:

```sh
go build -trimpath -ldflags='-s -w' -o rclone-oma ./cmd/rclone-oma
```

The image build should copy the resulting binary into `/usr/local/bin` and
install `fuse3`. A deployment can then select the OMA command only when both
`gatewayEndpoint` and `sandboxToken` are configured on the E2B object storage
options.
