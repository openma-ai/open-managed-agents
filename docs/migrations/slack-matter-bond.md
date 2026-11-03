# Migrating Slack from the install bridge to Matter Bonds and Loops

Parent: ADR 0013 step 2 / issue #458. Legacy install-bridge Slack
(`packages/slack`, `/v1/oma/integrations/slack`, Console Integrations → Slack)
keeps working until a later ADR step removes it after replacement acceptance.

## What changes for operators

1. Run the Matter service (`apps/matter`) next to OpenMA, with `MATTER_URL` /
   `MATTER_PROXY_SECRET` on the control plane as for Feishu/GitLab.
2. In Console → **Matter → Bonds → Link a Slack workspace**, paste:
   - Bot User OAuth Token (`xoxb-…`)
   - Signing Secret (Events API / Interactivity), and/or
   - App-level token (`xapp-…` with `connections:write`) for Socket Mode
3. If using the Events API, paste the shown Request URL into the Slack app’s
   Event Subscriptions and Interactivity. Subscribe at least to `app_mention`
   and message events the bot should see.
4. Create a **slack-agent** Loop on that Bond (or pass `agentId` when linking
   for the one-step flow).
5. Existing install-bridge publications are **not** unbound automatically.
   Leave them until you confirm Matter Loops handle production traffic, then
   retire publications manually. There is no destructive unbind in this step.

## What this step does not do

- Does not remove the legacy Slack bridge, routes, Console Integrations page,
  or `slack_*` provider tables.
- Does not DROP tables.
- Does not migrate historical session rows from the legacy SessionRegistry.

## Gaps

- Live Slack App install / OAuth marketplace flow is not required; operators
  paste credentials from an existing app.
- Linear and GitHub Matter hosting are out of the Slack-first slice (same
  pattern later; their `@openma/matter-*` packages still need publishing).
