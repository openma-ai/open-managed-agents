// Slack App Manifest helpers — pure logic.
//
// Reference: https://docs.slack.dev/reference/manifests
//            https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests
//
// The "Create from manifest" URL flow lets us prefill all manifest fields
// (App name, scopes, events, redirect URLs) and have the user confirm in one
// click on Slack's side. After they click Create, they still need to copy
// Client ID / Client Secret / Signing Secret back into the OMA wizard — Slack
// does NOT ship credentials via callback for the URL flow. The actual
// zero-copy path (apps.manifest.create REST API) requires a Configuration
// Token from the user, which is more friction than the URL flow saves; we
// don't use that path.
//
// Compared to manual app creation at api.slack.com, the URL flow saves the
// user from configuring 10+ scopes, the events-request URL, the redirect
// URL, and 7 event subscriptions one at a time. Net: ~3 minutes saved.

const SLACK_NEW_APP_URL = "https://api.slack.com/apps";

export interface SlackManifestInput {
  /** Persona-derived App display name. */
  personaName: string;
  /** Optional one-line app description, surfaced in Slack's app directory. */
  description?: string;
  /** Where Slack POSTs Events. We bake the OMA-internal app id into the path. */
  webhookUrl: string;
  /** Where Slack redirects after OAuth grant. Per-app; same OMA-internal id. */
  redirectUrl: string;
  /** Bot scopes — go in oauth_config.scopes.bot. */
  botScopes: ReadonlyArray<string>;
  /** User scopes — go in oauth_config.scopes.user. Required for mcp.slack.com. */
  userScopes: ReadonlyArray<string>;
  /** Bot events to subscribe to (e.g. app_mention, message.channels). */
  subscribedEvents: ReadonlyArray<string>;
}

/**
 * Build the JSON manifest. Pure function — no I/O.
 *
 * Schema follows https://docs.slack.dev/reference/manifests but stays
 * minimal: we set what we need and let Slack apply sensible defaults for
 * everything else.
 */
export function buildManifest(input: SlackManifestInput): Record<string, unknown> {
  // Aligned with Slack's official MCP-server sample:
  //   https://github.com/slack-samples/bolt-js-slack-mcp-server/blob/main/manifest.json
  // Required for Slack's "Agents & AI Apps" surface to work end-to-end:
  //   - features.app_home.messages_tab_enabled: true (+ read_only: false) so
  //     the bot has a message tab the assistant_view can dock under
  //   - features.assistant_view.suggested_prompts: [] so the field exists
  //     and Slack doesn't reject the manifest
  //   - bot scope `assistant:write` so the bot can use the Assistant API
  //     surface (set status, suggested replies, etc.)
  //   - bot events `assistant_thread_started` + `assistant_thread_context_changed`
  //     so the bot wakes up when the user opens the side pane
  //   - settings.interactivity.is_enabled: true (with request_url) — Slack
  //     gates several Assistant features behind this even if our app doesn't
  //     ship interactive components today
  //   - settings.is_mcp_enabled: true so the "Agents & AI Apps → Model
  //     Context Protocol" toggle is on at app creation. Earlier comment
  //     here said this wasn't a manifest field — that's now wrong; current
  //     manifest reference lists is_mcp_enabled as a boolean. Without this,
  //     mcp.slack.com rejects token init with "App is not enabled for Slack
  //     MCP server access".
  return {
    display_information: {
      name: input.personaName,
      description: input.description ?? `${input.personaName} — an OpenMA agent`,
    },
    features: {
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: {
        display_name: input.personaName,
        always_online: true,
      },
      assistant_view: {
        assistant_description: `Chat with ${input.personaName} in a side pane.`,
        suggested_prompts: [],
      },
    },
    oauth_config: {
      redirect_urls: [input.redirectUrl],
      scopes: {
        // assistant:write is required for Slack's Assistant API surface (set
        // status, suggested replies). Inject if caller didn't already include
        // it — most callers pass our DEFAULT_SLACK_BOT_SCOPES which we'll
        // also extend in config.ts.
        bot: input.botScopes.includes("assistant:write")
          ? [...input.botScopes]
          : [...input.botScopes, "assistant:write"],
        user: [...input.userScopes],
      },
    },
    settings: {
      event_subscriptions: {
        request_url: input.webhookUrl,
        // Same idempotent-merge for the two assistant events.
        bot_events: Array.from(
          new Set([
            ...input.subscribedEvents,
            "assistant_thread_started",
            "assistant_thread_context_changed",
          ]),
        ),
      },
      interactivity: {
        is_enabled: true,
        request_url: input.webhookUrl,
      },
      // Pre-flips the "Agents & AI Apps → Model Context Protocol" toggle on
      // app creation. Without this, mcp.slack.com returns 400 "App is not
      // enabled for Slack MCP server access" on token init and the agent
      // falls back to bash+curl for every Slack action — slow, missing
      // typed mcp__slack__* tools. Earlier docs claimed this wasn't a
      // manifest field; current reference (docs.slack.dev/reference/app-
      // manifest) lists `settings.is_mcp_enabled` as boolean, verified
      // against staging install 2026-05-19.
      is_mcp_enabled: true,
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

/**
 * Build the URL the user opens to start the manifest flow at Slack. The
 * manifest is JSON-stringified and URL-encoded into the query string;
 * Slack's UI parses it and shows a manifest editor pre-populated with our
 * values.
 */
export function buildManifestLaunchUrl(manifest: Record<string, unknown>): string {
  const json = JSON.stringify(manifest);
  const params = new URLSearchParams();
  params.set("new_app", "1");
  params.set("manifest_json", json);
  return `${SLACK_NEW_APP_URL}?${params.toString()}`;
}
