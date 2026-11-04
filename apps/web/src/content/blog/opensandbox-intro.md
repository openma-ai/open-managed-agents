---
title: "What OpenSandbox Is and Why OpenMA Supports It"
description: "OpenSandbox is AAIF's self-hosted sandbox API and runtime. How it relates to OpenEnv and Harbor, and how OpenMA uses it as an optional sandbox provider."
publishedAt: 2026-10-25
updatedAt: 2026-11-04
author: openma
tags: ["opensandbox", "sandbox", "self-host", "aaif", "harbor"]
---

Agents often do their actual work in a sandbox. The model reasons outside it, while commands, file edits, and dependency installs happen inside. You need to be able to host that sandbox yourself, control its outbound traffic, and keep credentials out of it where possible. OpenSandbox handles this layer.

It is now part of the Agentic AI Foundation (AAIF), contributed by Alibaba. Like MCP and OpenEnv, it follows neutral governance without tying itself to one cloud.

## The OpenSandbox API and reference implementation

OpenSandbox provides two things: a public OpenAPI covering lifecycle, execution inside the sandbox, egress, and credentials, and a reference implementation you can deploy yourself. It runs on Docker locally and Kubernetes in a cluster. You can integrate against the contract or install the reference implementation in your own data center.

Harbor already supports it as a backend: `-e opensandbox` selects it for evaluation tasks. E2B, Modal, and Daytona are other backend options. Applications work against Harbor or their own platform contract, with each sandbox's differences handled in the backend adapter layer.

One point needs to be clear: OpenSandbox does not officially target compatibility with E2B's wire protocol. Its priority is the long-term stability of its own lifecycle / execd / egress contracts. Migration can use a mapping table or a limited adapter layer. Do not expect to keep using the E2B SDK unchanged after switching the underlying sandbox.

## How OpenSandbox fits with OpenEnv and Harbor

These names are easy to mix up.

OpenEnv defines how environments are used for training and evaluation: the external interface is `reset` / `step` / `state`, while the environment behind it can be a game or a real coding agent. Harbor manages tasks, sandbox selection, the harness, and the verifier. OpenSandbox answers only the question of where processes run.

A common arrangement is OpenEnv wrapping Harbor, with Harbor selecting OpenSandbox as its execution backend. The coding agent is still a harness such as Claude Code, Codex, or OpenCode running inside the sandbox. OpenSandbox itself is not the harness.

## How OpenMA integrates OpenSandbox

Open Managed Agents (OpenMA) has its own sandbox contract: `SandboxProviderPort`, leases, fences, harness supervision, workspace, and credential egress. This contract covers much more than creating a container and running exec. We will not replace it with the OpenSandbox API.

The approach is the same as for E2B and Daytona: OpenSandbox is a provider adapter. Operators set `SANDBOX_PROVIDER=opensandbox` and point it at their OpenSandbox service. Sessions and Environment Work continue through OpenMA's existing control plane. The OpenSandbox server's API key stays in the control plane's connection configuration and is never injected into the sandbox's environment variables.

Correction: the first adapter ([#353](https://github.com/openma-ai/open-managed-agents/pull/353)) was a handwritten HTTP client tested only against mocks. External contributor [@jwx0925](https://github.com/jwx0925) found problems when running it against a real OpenSandbox service: the command stream format and the upload API's multipart fields differed from the mocks, causing requests to fail. This article originally said it was "supported." That claim was premature. [#364](https://github.com/openma-ai/open-managed-agents/pull/364) replaced the adapter with the official TypeScript SDK, `@alibaba-group/opensandbox`, and verified it against a real service. Thanks to @jwx0925.

Current limits: the adapter supports creation, reconnection, command execution, file reads and writes, lease renewal, and the harness's stdio channel. It does not yet support suspend, checkpoint, or cross-runtime restore.

For teams [self-hosting their agents](/self-hosted-ai-agents/), controlling data leaving their infrastructure, or avoiding a sandbox tied to one SaaS provider, this separates the platform core from the execution backend. OpenMA remains the core, and the backend can be OpenSandbox in their own data center.

## Configure the OpenSandbox provider

After bringing up your self-hosted OpenSandbox service, install the SDK in your OpenMA deployment (`@alibaba-group/opensandbox`, an optional dependency needed only when selecting this provider), then configure:

```bash
SANDBOX_PROVIDER=opensandbox
OPENSANDBOX_DOMAIN=localhost:8080   # host[:port] only, without a scheme or path
OPENSANDBOX_PROTOCOL=http           # Change to https if the service uses TLS
OPENSANDBOX_API_KEY=...             # Required only if server authentication is enabled
```

The old `OPENSANDBOX_BASE_URL` is no longer used. See the [adapter README](https://github.com/openma-ai/open-managed-agents/blob/main/packages/sandbox-adapter-opensandbox/README.md) for the full options, including resources, lifecycle, and image requirements. For Harbor evaluations, you can also run `harbor run -e opensandbox` directly, independently of the OpenMA integration.

## References

1. [AAIF: four new projects announced, including OpenSandbox](https://aaif.io/news/agentic-ai-foundation-announces-four-new-projects)
2. [OpenSandbox](https://github.com/opensandbox-group/OpenSandbox)
3. [OpenSandbox API](https://open-sandbox.ai/api/)
4. [Harbor × OpenSandbox evaluation example](https://open-sandbox.ai/examples/harbor-evaluation)
5. [Open Managed Agents](https://github.com/openma-ai/open-managed-agents)
6. [PR #353: initial OpenSandbox provider adapter](https://github.com/openma-ai/open-managed-agents/pull/353)
7. [PR #364: switch to the official SDK, verified against a real service](https://github.com/openma-ai/open-managed-agents/pull/364)
