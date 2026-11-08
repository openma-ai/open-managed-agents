# Sandbox images on Cloudflare (`SANDBOX_IMAGES`)

On Node, `SANDBOX_IMAGES` maps an alias to an image reference that the
sandbox provider pulls when a session starts (see [self-host.md](self-host.md)).
Cloudflare cannot pull at session start: wrangler builds one image per
**container class** at deploy time. On Cloudflare an alias therefore names a
container class the operator declared on the agent worker. Users still pick
only an alias (`_oma.sandbox_image`); raw images are never accepted.

## Catalog

Set `SANDBOX_IMAGES` as a var (JSON string) on the **main** worker
(`apps/main/wrangler.jsonc`). Same object and validation as Node
(`alias` pattern, `reference`, `label`, `description`, unknown keys rejected),
plus two Cloudflare keys:

```json
{
  "fix-git": {
    "reference": "alexgshaw/fix-git:20251031",
    "binding": "SANDBOX_FIX_GIT",
    "workdir": "/app/personal-site",
    "label": "fix-git"
  }
}
```

| key | |
|---|---|
| `reference` | The source image. Keep it equal to the Harbor task's `docker_image` so the eval importer maps the task to this alias. Not used to pull anything. |
| `binding` | Required. The agent worker's Durable Object binding of the container class built from that image. |
| `workdir` | The image's `WORKDIR` (absolute), exactly as the image declares it (`docker inspect -f '{{.Config.WorkingDir}}' <image>`). Default `/workspace`. The CF SDK cannot read it from the image, so declare it. Evals run Harbor's solve.sh and tests in this directory: a wrong value makes every trial fail. |

- `GET /v1/oma/sandbox_images` lists the aliases (never `reference`/`binding`).
- `POST/PUT /v1/environments` accepts `_oma.sandbox_image` only for an alias in the catalog.
- At session start the main worker resolves the alias again and sends
  `{alias, binding, workdir}` to SessionDO in `/init`. A removed alias fails the
  start (`SandboxImageUnavailableError`); it never falls back to `SANDBOX`.
- SessionDO builds the session's sandbox on `env[binding]` (default `SANDBOX`).
  A binding the agent worker does not declare fails sandbox creation.
- A malformed `SANDBOX_IMAGES` fails the requests that read it (listing,
  environment create/update with an image, session start with an image).

## Adding a Harbor task image

1. **Dockerfile.** `FROM <task image>` plus the `@cloudflare/sandbox` control
   server (`/container-server/sandbox` from `cloudflare/sandbox:<sdk version>`)
   as the entrypoint. Start from
   [`apps/agent/Dockerfile.harbor-task.example`](../apps/agent/Dockerfile.harbor-task.example).
   The task's `WORKDIR` is kept.
2. **Container class.** In `apps/agent/src/operator-sandboxes.ts`:
   `export class SandboxFixGit extends OmaSandbox {}` (extend `OmaSandbox` so
   vault egress, backups and billing behave like the default sandbox).
3. **`apps/agent/wrangler.jsonc`.** Add a `containers` entry
   (`class_name` + `image`), a Durable Object binding
   (`{"name": "SANDBOX_FIX_GIT", "class_name": "SandboxFixGit"}`) and a new
   migration tag with `"new_sqlite_classes": ["SandboxFixGit"]`. Repeat in each
   `env.*` overlay you deploy. The comment above `containers` shows the shape.
4. **Catalog.** Add the alias to `SANDBOX_IMAGES` on apps/main and deploy both workers.

Do not commit real task images to the shared config; keep them in the
operator's deployment config.

## Workspace root and exec

`CloudflareSandbox.resolveWorkspaceRoot()` returns the entry's `workdir`, else
`/workspace` (ADR 0016). With a `workdir`, every `exec` and background process
runs with that `cwd`. Workspace backups still cover `/workspace` (ADR 0016
rollout step 4 is not done on Cloudflare).

## Image WORKDIR and ENV for evals

Harbor runs the oracle and the verifier in the image's `WORKDIR` with its
`ENV`. On Cloudflare the eval runner takes the `WORKDIR` from the catalog's
`workdir` and reads no registry: the container is built `FROM` the task image,
so its `ENV` is already in every exec, and Docker Hub rate-limits the shared
Workers egress (HTTP 429). Node still reads both from the image registry.

## Grading in the session sandbox

`POST /v1/oma/sessions/:sessionId/sandbox/exec` `{command, timeout_ms?}` →
`{exit_code, output}` runs `sh -c <command> 2>&1` in the Session's own
sandbox, same contract as Node: 400 bad body, 404 missing/archived session,
409 while running/rescheduling or for a `self_hosted` environment, 502 on
sandbox failure. Cloudflare keeps the first 100 KB of output.

The container sleeps after 5 minutes without activity (`OmaSandbox.sleepAfter`).
Every SDK call renews that timer, and a call in flight keeps it renewed, so a
blocking exec or a detached verifier polled with exec every 5–15 s stays awake.
