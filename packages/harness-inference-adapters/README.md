# Harness inference adapters

Harbor-style per-harness translation from OpenMA hosted inference (`HOSTED_INFERENCE_*` on the control plane) into harness-native env vars and config files.

## DeepSeek harness (`dsh`)

`DEEPSEEK_BASE_URL` points at the **Anthropic Messages** API root for DeepSeek (for example `https://api.deepseek.com/anthropic` upstream, or `{hosted}/anthropic` through the session proxy). It is **not** an OpenAI-compatible Chat Completions base URL.

See `dshInferenceAdapter` for the hosted-proxy mapping.
