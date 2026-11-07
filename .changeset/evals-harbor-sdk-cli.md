---
"@openma/sdk": minor
"@openma/cli": minor
---

Add eval support (benchmarks → cases → eval runs, Harbor and messages kinds): `client.oma.evals` in the SDK (`benchmarks` list/listBuiltin/create/retrieve/update/delete/upload, `benchmarks.cases` retrieve/add/replace/delete, `runs` create/list/retrieve/cancel/delete/waitForRun) and `oma evals benchmarks …` / `oma evals cases …` / `oma evals run` / `oma evals runs …` in the CLI.

Harbor benchmarks are read-only imports with immutable revisions: new `git` source (github.com / huggingface.co), `benchmarks.sync`/`syncUpload` and `{ revision }` on benchmark/case retrieve in the SDK; `oma evals benchmarks import --git <url> [--ref] [--path]`, `oma evals benchmarks sync <id> [--ref|--file]` and `--revision N` on benchmark/case show in the CLI. Harbor case add/replace/delete helpers and empty harbor benchmarks are removed.
