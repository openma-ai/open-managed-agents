# Backchat / OMA live acceptance

Run the real OMA API, a local ACP worker using the shared common runtime, and
Backchat Electron continuation/restart from one explicit JSON configuration.
The API may run in Docker; this runner does not start or modify your deployment.
It does not use the legacy CLI daemon to claim Work.

## Run

1. Start an isolated OMA API and provision a workspace API key with membership
   in the configured tenant. The tenant/user fields must match that account.
2. Build the Backchat checkout (`pnpm build`). Set `backchatDir` to its path.
3. Copy `backchat-deepseek.example.json` and set the API URL, tenant/user,
   ACP executable and exact model ID. Relative paths resolve from the command's
   working directory. `deepseek-flash` is the currently observed official alias;
   this configuration does not assert a particular version behind the alias.
4. Supply `OPENMA_LIVE_TEST_TOKEN` and `DEEPSEEK_API_KEY` in the invoking process
   environment. No credentials are loaded implicitly from your home directory.
5. From the OMA repository root:

   ```sh
   pnpm test:live:backchat /path/to/profile.json --check
   pnpm test:live:backchat /path/to/profile.json
   ```

`--check` validates configuration and required environment variables and prints
only the selected settings. It does not call APIs or launch ACP/Electron.
Missing model, ACP command, or credentials fail immediately. There is no Codex
fallback. `{model}` must appear in ACP arguments or environment settings so the
same selection reaches both the OMA agent definition and actual ACP invocation.
`{workspace}` expands to a fresh directory; use it for provider state/session
paths. `{ "fromEnv": "NAME" }` imports a credential without embedding its value
in the JSON. Arguments are passed directly to the executable, without a shell.

## Assertions and evidence

- Create an agent, self-hosted environment and session; claim Environment Work
  with a temporary environment key.
- Require the first actual agent response from the configured ACP/model.
  Session errors fail the test immediately, including unsupported capabilities.
- Launch Backchat, verify the configured tenant defaults to collapsed, continue
  that session, verify the result in OMA, and assert exactly one user input.
- Restart the desktop and verify retained history without resending the input.

Each invocation writes a unique run directory under `outputDir`, including
`report.json`, stage/error details, and desktop logs/screenshots when reached.
Workspace and provider credentials are redacted from runner reports/logs.
The report records the **requested** model ID and command; it is not proof of
which implementation a provider alias resolves to.

The worker is stopped and its temporary environment key revoked on completion
or failure. Agent/environment/session records and the isolated local workspace
remain for inspection; their IDs/paths are in the report. The workspace API key
is owned by the caller and is never revoked by this runner.

## Steering capabilities

The tested DeepSeek ACP 0.4.6 does not advertise `_session/steering`.
This optional extension no longer blocks ordinary sessions in common; an
unsupported active-turn steering request fails explicitly. Backchat keeps its
queue enabled and visible for agents without steering, even when the global
queue setting is off. DeepSeek extension support is tracked in
[deepseek-harness-acp#23](https://github.com/openma-ai/deepseek-harness-acp/issues/23).

Offline configuration regression checks:

```sh
pnpm test:live:backchat:config
```
