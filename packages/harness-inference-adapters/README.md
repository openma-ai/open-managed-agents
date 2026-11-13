# Harness inference adapters

Harbor-style per-harness translation from OpenMA hosted inference (`HOSTED_INFERENCE_*` on the control plane) into harness-native env vars and config files.

## DeepSeek harness (`dsh`)

`DEEPSEEK_BASE_URL` points at the **Anthropic Messages** API root for DeepSeek (for example `https://api.deepseek.com/anthropic` upstream, or `{hosted}/anthropic` through the session proxy). It is **not** an OpenAI-compatible Chat Completions base URL.

See `dshInferenceAdapter` for the hosted-proxy mapping.

## Native protocol contracts

The adapter table is handwritten. Selection intersects these declarations with
Pi-native model-card endpoints, prefers Messages when available, and rejects an
empty intersection. It does not convert protocols or change the selected model.

| Adapter | Configured native protocols | Configuration contract |
| --- | --- | --- |
| Claude ACP | Messages | Anthropic env and settings |
| Codex ACP | Responses | `model_providers.oma.wire_api = "responses"` |
| Pi ACP | Messages, Responses, Google, Chat | Selected native `models.json` api |
| dsh | Messages | `deepseek-official` provider and Anthropic base URL |
| Gemini | Google | Gateway base URL and literal scoped bearer header |
| Kimi Code | Messages, Responses, Google, Chat | `config.toml` provider type, model and `api_key_env` |
| OpenCode | Messages, Responses, Google, Chat | v1 `provider.oma.npm` native SDK and explicit model entry |

Registry installs pin Claude ACP 0.94.0, Codex ACP 1.8.0 and Pi ACP 0.1.8.
The generic Kimi, OpenCode, Gemini and dsh integrations have **no repository
version pin**. This table is not a promise for every executable carrying those
names. In particular, OpenCode uses the v1 schema, checked against upstream
[v1.2.21](https://github.com/anomalyco/opencode/tree/v1.2.21/packages/opencode/src/provider);
it does not generate v2 `providers.*.package` fields. Kimi config is checked
against upstream commit
[410814349d4677fc2844ad79069b0ad4a751303a](https://github.com/MoonshotAI/kimi-code/tree/410814349d4677fc2844ad79069b0ad4a751303a/packages/node-sdk/src/config),
not the archived Python kimi-cli. Its env-model override only supports three
provider types, so generated config owns selection instead. The required context
size preserves that implementation's prior env-model default, not model-card
pricing or capacity metadata. dsh's declaration describes the configured
DeepSeek route, not all provider backends offered by upstream dsh.

Only scoped host-proxy credentials enter harness environments. Kimi and OpenCode
configurations reference that environment token; Gemini's header parser requires
the scoped value directly and does not expand `{env:...}`. Provider credentials
remain on the host. These config regressions do not constitute live provider
compatibility or four-topology acceptance.
