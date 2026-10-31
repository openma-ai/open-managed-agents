# @openma/cli

Command-line client for [openma](https://openma.dev) managed agents.

> **Beta.** API surface and command names may change before 0.1.0 final.

## Install

```bash
npm i -g @openma/cli
```

This installs an `oma` binary on your `PATH`. (If a different `oma` is already installed, npm will overwrite or warn — both are safe.)

## Configure

```bash
export OMA_API_KEY=sk_...
export OMA_BASE_URL=https://api.openma.dev   # default
```

Generate an API key from the [openma console](https://openma.dev) → API Keys.

## Usage

```bash
oma agents list
oma agents create --name my-agent --model claude-sonnet-4-6
oma sessions list
oma sessions create --agent <agent-id> --env <env-id>
oma session <session-id> tail        # follow events live
oma linear publish <agent-id> --env <env-id>
oma api                              # HTTP API quick reference
```

Run `oma --help` for the full command tree.

## MCP OAuth connection

Run `oma connect linear --vault <vault-id>` (or pass an MCP server URL). The CLI
POSTs authorization with your configured API key, opens the returned provider
URL, then polls with an independent private claim credential. If the browser
cannot open automatically, use the printed URL. You do not need to sign in to
the Console in that browser.

The provider continues to use the service's registered `/v1/oma/oauth/callback`;
there is no random localhost listener or new loopback registration requirement.
Claims expire after 10 minutes and are single-use, bound to the original API
key and workspace. Only the new credential ID is returned, never its tokens.
`oma api mcp` shows the POST endpoints. Do not put API keys, client secrets or
claim credentials in browser URLs.

## Local daemon power management

`oma bridge daemon` automatically keeps the machine available for local tasks
while it is running, including while idle and during graceful shutdown. The
screen can still turn off. No extra switch is required.

The adapter uses macOS `caffeinate`, Linux `systemd-inhibit`, or the Windows
power-management API through PowerShell. It releases the sleep assertion when
the daemon exits. If the OS denies the request or the helper is missing, the
daemon logs a warning and retries every 30 seconds. Linux requires logind and
permission to acquire an inhibitor; explicit sleep and OS policy may override
power requests.

Service-mode process recovery continues to use launchd KeepAlive on macOS and
systemd Restart=always on Linux. Windows currently installs a logon task, not a
crash-restart policy. Foreground execution has no external process supervisor.

## License

MIT
