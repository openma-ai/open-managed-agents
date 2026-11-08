# ADR 0017: Harbor benchmarks are read-only imports with immutable revisions

**Status**: Proposed (2026-11-07)
**Owner**: @hrhrng
**Tracking**: [#531](https://github.com/openma-ai/open-managed-agents/issues/531)
**Supersedes**: None
**Related**: [`0016-workspace-root-from-image.md`](0016-workspace-root-from-image.md),
Harbor (`harbor-framework/harbor`: `models/task/id.py`, `models/registry.py`,
`publisher/packager.py`), OpenEnv (`openenv/OpenEnv`: `src/openenv/harbor/tasks.py`)

---

## Context

OMA runs Harbor-format tasks on managed Sessions (#531). The first cut stored
each imported task by name and let clients add, replace and delete harbor
cases in place. A trial read its task from storage when it ran
(`packages/evals-runner/src/harbor.ts`, `loadTask`), so an edit during a run
would change what later trials graded; the routes therefore refused case
writes with 409 while a run was active. Two runs of "the same benchmark" could
also have graded different content with nothing recording it.

The ecosystem does not edit tasks inside the platform that runs them:

- **Harbor** tasks come from exactly three places (`models/task/id.py`): a git
  repository at a commit, a local directory, or a Harbor Hub package. Its
  public `registry.json` is only an index of git entries: on 2026-11-07 it
  listed 80 datasets, 51,625 tasks, 41,767 on github.com and 9,858 on
  huggingface.co, every one pinned to a commit. `harbor publish` hashes a task
  (`publisher/packager.py`, sha256 over sorted `"path\0sha256(file)\n"`) and
  creates a new revision only when that hash changed.
- **OpenEnv** (`src/openenv/harbor/tasks.py`) serves Harbor datasets without
  storing or editing them: a dataset is a source string (HF repo, local
  directory, Harbor `name@version`) resolved to task directories. It does not
  pin HF downloads, so a dataset update silently changes what an index means.

## Decision

1. **Harbor benchmarks are read-only.** OMA must not create, replace or delete
   a harbor case in place. Cases are authored at the source (git, Hub, a local
   directory that is uploaded) and brought in by import or sync. Messages
   benchmarks stay editable in OMA: their runs already copy the cases.
2. **Sources.** A harbor benchmark has one source: `git` (`url`, `ref`,
   `path`; github.com and huggingface.co), `registry` (Harbor
   `registry.json`, whose entries are git), `builtin` (a git commit OMA ships)
   or `upload` (a tar archive). Other git hosts and Harbor Hub packages must be
   refused with an explicit error until they are supported.
3. **Resolve, then pin.** Every import and sync resolves refs to full commit
   shas (git smart-HTTP ref advertisement) before reading files, and records
   them as the revision's pins. Files are read at the pinned commit only.
4. **Content digest.** A case's digest uses Harbor's package hash algorithm
   over the files OMA stores (task.toml, instruction.md, tests/, solution/,
   environment/docker-compose.*). environment/ is not stored because cases run
   from their prebuilt `docker_image` (ADR 0016); the digest therefore differs
   from a Harbor Hub digest of the same task and must be documented as such.
   A revision's digest is sha256 over sorted `"name\0case digest\n"`.
5. **Immutable revisions.** Import makes revision 1. Sync makes revision N+1
   only when the revision digest changed; otherwise nothing is written.
   Revisions and case files (addressed by digest) are never rewritten.
6. **Runs bind a revision.** A harbor run records the benchmark revision and
   each case digest at creation and reads cases by digest. Case changes never
   affect an existing run; the 409 lock on case writes is removed. Deleting a
   benchmark is still refused while one of its runs is active.

## Consequences

- Scores are reproducible and attributable: a run names the exact revision,
  commits and case digests it graded.
- No editing UI or copy-on-write logic for harbor cases. Quick edits in the
  console are no longer possible; authors edit the repository and sync.
- Storage grows with revisions (content-addressed, so unchanged cases are not
  copied). There is no garbage collection of old revisions yet.
- Imports run inside one request. Hub imports download each kept file
  separately, so very large datasets (thousands of tasks) must be imported in
  subsets with `case_names` until imports run as background jobs.

## Alternatives considered

- **Editable cases with copy-on-write versions.** Rejected: duplicates what
  git already does, and no other Harbor consumer edits tasks in the runner.
- **Resolve sources live at run time (OpenEnv style).** Rejected: an upstream
  change would change a running benchmark; Workers would re-download every
  task per run.
- **Use Harbor Hub digests.** Rejected for now: requires storing and hashing
  environment/ build contexts OMA never runs.

## Rollout

1. Storage, sync endpoint, git (GitHub + Hub) sources, run binding (#544).
   Verified by unit and route tests and by importing a real registry dataset
   hosted on the Hub on main-node.
2. SDK, CLI (`oma evals benchmarks sync`, `--git`) and console (source pins,
   revision list, sync button) in the same PR.
3. Later: Harbor Hub packages, other git hosts, background imports for large
   datasets, multi-step tasks.
