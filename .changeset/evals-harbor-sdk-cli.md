---
"@openma/sdk": minor
"@openma/cli": minor
---

Add eval support (benchmarks → cases → eval runs, Harbor and messages kinds): `client.oma.evals` in the SDK (`benchmarks` list/listBuiltin/create/retrieve/update/delete/upload, `benchmarks.cases` retrieve/add/replace/delete/upload/replaceUpload, `runs` create/list/retrieve/cancel/delete/waitForRun) and `oma evals benchmarks …` / `oma evals cases …` / `oma evals run` / `oma evals runs …` in the CLI.
