# ADR 0009: GitHub Bonds, repository picking, and execution principals

**Status**: Proposed (2026-10-12)

**Related**: [`0006-session-execution-authority.md`](0006-session-execution-authority.md),
[`0007-sandbox-credential-egress.md`](0007-sandbox-credential-egress.md),
[`0010-gitlab-bonds.md`](0010-gitlab-bonds.md) (GitLab without a bot),
[`../secrets-design.md`](../secrets-design.md),
[`../mcp-credential-architecture.md`](../mcp-credential-architecture.md),
[`../github-pr-flow.md`](../github-pr-flow.md),
OpenMatter [`docs/BONDS.md`](https://github.com/openma-ai/OpenMatter/blob/main/docs/BONDS.md)

## Context

A user who wants an agent to work on a private GitHub repository must paste a
token into every Session:

- `github_repository` requires `authorization_token`
  (`packages/managed-agents-api/src/contracts/sessions.ts:86`). The console
  form sends whatever the user pasted
  (`apps/console/src/pages/SessionsList.tsx:447-449`).
- The resolver seals that token per Session resource
  (`packages/managed-agents-application/src/sessions/resource-resolver-service.ts:131`).
  Node later reads it back with `findGithubToken`
  (`packages/session-resource-store-sql/src/index.ts:33`).
- Node injects it once as static `GIT_CONFIG_*` environment
  (`apps/main-node/src/lib/node-managed-session-inputs.ts:280-308`). E2B
  applies command secrets only when the command string starts with the
  registered prefix (`packages/sandbox-adapter-e2b/src/e2b.ts:666`). An agent
  command such as `cd repo && git push` therefore runs without credentials.
- Node's `/oma/integrations/github/credentials` is a stub that returns an
  empty list (`apps/main-node/src/modules/node-http.ts:582`).

The existing GitHub integration solves a different problem. It binds one agent
persona to one publication with its own manifest-registered GitHub App, for
issue- and PR-triggered sessions (`packages/github/src/provider.ts:1-30`,
`:494-602`). It has no notion of "this OMA user is this GitHub user", and its
one-App-per-persona shape is the model OpenMatter's identity decision rejects.

Sessions also do not record who created them. `managed_sessions` has
`workspace_id` but no user column
(`apps/main-node/migrations/0005_true_may_parker.sql:16-29`). Per-user
ownership, viewing, and follow-up rules cannot be expressed today.

Comparable products converge on one organization-level GitHub App plus a
per-user link:

- **Cursor** requires the link and limits agents to repositories the
  requesting user can already reach.
- **Devin** makes the link optional and uses it for attribution.

In `openma-ai`, all 106 Cursor pull requests were opened by the requesting user
through the Cursor App (`performed_via_github_app = cursor`). Commits were
authored by `Cursor Agent <cursoragent@cursor.com>`, a regular User account
rather than an App bot, signed (Verified), and `Co-authored-by` the user. The 11
user-opened Devin pull requests carry no App marker.

The provider-neutral kernel, ports, principal policy, and conformance suite are
specified in OpenMatter `docs/BONDS.md` (the Bond module). This ADR decides
how the OMA control plane adopts them. OMA uses the OpenMatter term Bond in
the console, the API, and the schema (`bond_` table prefix); see ADR 0011.

## Decision

### One deployment-level GitHub App

OMA registers one GitHub App per deployment for Bonds. It does not reuse
publication Apps. The App:

- requests repository `contents`, `pull_requests`, `issues`, `checks`, and
  `metadata` permissions, plus `actions` read;
- enables "Request user authorization (OAuth) during installation" and
  user-to-server token expiry;
- delivers `installation`, `installation_repositories`, and
  `github_app_authorization` webhooks to a dedicated gateway route.

Its private key, client secret, and webhook secret are Layer A bootstrap
secrets under `secrets-design.md`. They come from the mounted YAML or secret
manager and never from the database.

Existing publications are unchanged. Converging them onto this App is out of
scope.

### Connect flow

The console has one **Connect GitHub** action. The server decides the path:

| State | Flow | Result |
| --- | --- | --- |
| No installation for the chosen account | install with authorize-during-install | Installation and the installer's UserLink |
| Installed, user not linked | user authorization only | UserLink |
| Linked | none | — |
| Link `refresh_failed` or revoked | user authorization only | new UserLink |

An installation belongs to exactly one workspace. When the callback
carries an `installation_id`, the server claims it only after the user's own
token lists it in `GET /user/installations`. An installation id in a
callback, webhook, or log is never proof by itself. An installation created
from GitHub without an OMA callback stays `pending` until such a user claims
it. A claim against an installation owned by another workspace fails with
`github_installation_owned_elsewhere` and changes nothing. Moving it requires
the owning workspace's administrator to release it, or an uninstall and
reinstall on GitHub. Webhooks for an installation go only to its owning
workspace.

The repository picker offers this action inline when the user is not linked.
OAuth state is signed, single-use, short-lived, and bound to the OMA user and
workspace. Callback and webhook routes mount on the existing integrations
gateway (`GATEWAY_ORIGIN`).

### Storage

Bonds are Layer B credentials: an agent uses them outbound on a user's
behalf. They live in dedicated tables rather than vault credentials, for three
reasons:

- vaults are tenant-scoped and attached by `vault_ids`, with no owner user;
- their refresh dedup is best-effort (`mcp-credential-architecture.md`,
  "Concurrent refresh dedup");
- that document notes that GitHub App installation tokens need
  provider-specific handling.

New tables, added through the existing Drizzle migrations for PostgreSQL,
MySQL, and SQLite:

```text
bond_installations
  id, workspace_id, provider_app_id, provider_installation_id, account_login,
  account_type, repository_selection, status, claimed_by_user_id,
  created_at, updated_at, suspended_at, released_at, revoked_at
  unique (provider_app_id, provider_installation_id)

bond_user_links
  id, workspace_id, user_id, provider_app_id, provider_user_id, login,
  method, access_token_cipher, refresh_token_cipher, cipher_key_id,
  access_expires_at, refresh_expires_at,
  refresh_lease_owner, refresh_lease_expires_at,
  refresh_failure_reason, status, created_at, updated_at,
  revoked_at, revoked_reason
  unique active link per (workspace_id, user_id, provider_app_id)
```

- `provider_app_id` identifies the App through a `bond_provider_apps` row
  (ADR 0010). For this ADR it is the deployment GitHub App; a workspace gets
  its row the first time it connects. ADR 0010 adds GitLab instances. In the
  console and API that row is the workspace's GitHub Bond (ADR 0011).
- A link is per App, not per installation. A GitHub user-to-server token
  reaches every installation of the App that the user can access. The
  resolver picks the installation per Session resource. A workspace
  installed on two GitHub organizations therefore holds one link per user,
  and one refresh lease guards it.
- Ciphertext uses `secrets.cipherFor("bonds.github.user_tokens")`
  (`apps/main-node/src/secrets.ts:17`), which a deployment may back with KMS.
- Installation tokens are not persisted. They are minted per use, scoped to
  the requested repository, and cached in process memory until 5 minutes
  before expiry.
- The SQL adapter must pass OpenMatter's `bondStoreConformanceCases`
  against all three databases in CI.

`managed_sessions` gains a nullable `created_by_user_id`. It is set from the
authenticated `user_id` (`packages/auth/src/index.ts:165`, `:280`). Legacy
sessions and API keys without a user stay `NULL` and can only use the app
principal.

### Session API: Bond-backed repositories

`github_repository` keeps `authorization_token` unchanged for Claude Managed
Agents compatibility. OMA adds one mutually exclusive extension:

```jsonc
{
  "type": "github_repository",
  "url": "https://github.com/acme/api",
  "checkout": { "type": "branch", "name": "main" },
  "oma_credential": { "type": "bond" }   // instead of authorization_token
}
```

At creation the resolver:

1. finds the active installation that covers the repository owner and is
   owned by this workspace;
2. applies the workspace principal policy to the creator's link for the App;
3. for a user principal, confirms the repository appears in the user's
   intersection list;
4. stores a sealed reference `{installationId, userLinkId?, policy}` under a
   new `secret_type = 'github_bond'`. No token is stored per Session.

`SessionResourceSecretSource.findGithubToken` generalizes to
`findGithubCredential`. It returns either `{ type: "token" }` (legacy) or
`{ type: "bond" }`.

Errors are explicit: `github_not_installed`, `github_link_required`, and
`github_repository_not_accessible`. Nothing silently falls back to a pasted or
deployment token.

### Repository picker

The picker uses the generic `GET /v1/oma/bonds/{bondId}/resources?query=`
(ADR 0011). For GitHub the binding returns, for the current user, the
intersection of installation repositories and the user's own access
(`GET /user/installations/{id}/repositories` with the user token), paged and
cached briefly per link. The console replaces the URL and token inputs with
this picker. The URL and token form remains under an "advanced" disclosure for
compatibility.

### Sandbox credential delivery

Static `GIT_CONFIG_*` injection is replaced, for Bond-backed resources,
by a git credential helper written during Session input preparation:

- `git config --global credential.https://github.com.helper oma` installs a
  small helper. Git invokes the helper for every command form, including
  `cd repo && git push`.
- The helper calls `POST /v1/oma/sessions/{id}/git-credential` with the
  Session's current Work capability (ADR 0006). The host checks the execution
  fence, maps the requested path to a Session resource, and returns a
  repository-scoped installation token with the minimum permissions.
- User tokens never enter the sandbox. The token git receives is short-lived,
  scoped to one repository, and acts as the app principal.

When a provider offers enforced egress transforms (ADR 0007
`CredentialEgressPort`), the helper is replaced by header injection and the
token no longer reaches the sandbox. Haven and open-source E2B do not offer
that today. Moving the legacy `authorization_token` path to the same helper is
a separate follow-up.

### Attribution

| Artifact | Principal | Shape |
| --- | --- | --- |
| Commits | app | author and committer `<slug>[bot] <BOT_ID+<slug>[bot]@users.noreply.github.com>`, where `BOT_ID` is the bot user ID from `GET /users/<slug>[bot]`, not the App ID; `Co-authored-by: <login> <ID+login@users.noreply.github.com>` for the Session creator and every user who sent a message |
| Branch push | app | repository-scoped installation token via the helper |
| Pull request open, PR comments | per policy | `user`: user-to-server token, shown "with `<app>`"; `app`: bot, body includes `Requested by @login` |
| Automations, webhooks, shared IM entries | app | never a person's link |

Pull requests and comments made with a user principal are host-side
operations. They are exposed to the agent as a Bond tool through the
existing MCP proxy (`/v1/oma/mcp-proxy/<session>/<server>`). The user token
stays in the control plane. In-sandbox `gh` keeps the app principal.

Co-author trailers come from a `prepare-commit-msg` hook. The hook reads a
participants file that the host refreshes at each Turn start. The host also
writes `user.name` and `user.email` for the bot identity into the sandbox git
config. It resolves the bot user ID once per deployment.

Commits made with `git commit` in the sandbox are unsigned. Cursor's commits
are signed and show Verified. A repository whose branch protection requires
signed commits rejects such a push. This ADR accepts unsigned commits for v1.
Signing is an open question.

Workspace setting `github.pr_principal`:

- `app`;
- `user` (default): the user principal, falling back to app and recording
  `fallback: true`;
- `user_only`: fails when the user is not linked.

Workspace setting `github.pr_principal_participants` (default `false`): when
it is true, a pull request or comment may run as another user who sent input
to the Session and holds a valid link. The creator remains the default. The
chosen participant is recorded in the audit fact.

Every resolution writes the audit fact defined in OpenMatter `BONDS.md`.

### Multi-user rules

- A Session's Bond credentials are bound to `created_by_user_id`.
  Follow-up messages never switch the principal.
- Viewing a Bond-backed Session requires the viewer's own link with
  access to its repositories.
- Workspace setting `sessions.followups_from_others`:
  - `disabled` (default for Bond-backed Sessions);
  - `service_accounts_only`;
  - `all`.

  The setting documents the same lateral-movement risk Cursor warns about: a
  follow-up steers an agent that holds another user's authority.
- Unlinking, or removing a member from the workspace, revokes their links. It
  writes tombstones, calls GitHub grant revocation, and fails future
  resolutions for their Sessions with `github_link_required`.

### Configuration

New flat YAML keys, compatible with a mounted or baked deployment config:

```yaml
GITHUB_BOND_APP_ID: "123456"
GITHUB_BOND_APP_SLUG: "openma"
GITHUB_BOND_CLIENT_ID: "Iv1.xxxxx"
GITHUB_BOND_CLIENT_SECRET: "<secret>"
GITHUB_BOND_PRIVATE_KEY: "<pem>"
GITHUB_BOND_WEBHOOK_SECRET: "<secret>"
```

GitHub Bonds are disabled when the App ID is absent. The console then hides
Connect GitHub and keeps the token form.

## Compatibility

- Requests with `authorization_token` behave exactly as before.
- `oma_credential` is an OMA extension. Official Claude Managed Agents clients
  never send it, and responses never echo it.
- No existing table changes meaning. `created_by_user_id` is nullable.
- Publications, their Apps, vaults, and webhooks are untouched.

## Verification gates

Each PR carries the org evidence report for its head SHA. The feature is not
called done until these run against a real GitHub organization and the Haven
deployment:

1. Conformance suite passes on PostgreSQL, MySQL, and SQLite.
2. First admin: one redirect yields an installation and a link. Second
   member: authorize only.
3. The picker lists exactly the installation ∩ user repositories. A
   repository outside the user's access is rejected at Session creation.
4. A private repository clones in a Haven sandbox. `cd repo && git push`
   succeeds, including after the cached installation token expires (forced
   by cache invalidation).
5. A pull request opened under policy `user` shows the user with
   `performed_via_github_app = <slug>`. Commit author and committer link to
   the `<slug>[bot]` account. Co-author trailers link to the creator and
   every participant.
6. Revoking the App authorization on GitHub tombstones the link. The next
   resolution returns `github_link_required`.
7. No user or installation token appears in Session events, logs, the
   sandbox environment, or API responses.
8. A second workspace cannot claim an installation another workspace owns.
   A callback with an `installation_id` that the user's token does not list
   is rejected. Release, then claim, moves ownership.
9. One user link serves two installations of the App in the same
   workspace. Concurrent refreshes still commit one rotation.

## Consequences

- Users link once. Picking a repository replaces pasting a token, and access
  can never exceed what the user already has.
- OMA depends on `@openma/matter` (for `/bond`) and `@openma/matter-github`.
  They pull in Effect and Octokit, but not the OpenMatter runtime: importing
  `/bond` loads no runtime code.
  They are installed from npm at one shared version, like `@openma/common`
  (see ADR 0011). A version bump is a reviewed lockfile change.
- The control plane must be reachable from sandboxes for the credential helper,
  as it already must be for the MCP proxy.
- The git token still exists inside the sandbox while a command runs. It is
  repository-scoped, short-lived, and app-principal, but it is not absent.
  ADR 0007 egress removes it where providers allow.
- A second GitHub App exists alongside publication Apps until a later decision
  converges them.

## Delivery plan

Each step is one PR (conventional title, squash, evidence report):

1. `docs(adr): add 0011 Matter, and rename 0009 and 0010 to Bonds`. This
   document lands with ADR 0010 and ADR 0011.
2. `feat(sessions): record created_by_user_id`.
3. `feat(bonds): add Bond tables and SQL BondStore`. This
   PR runs the OpenMatter conformance suite.
4. `feat(bonds): add Connect GitHub install and authorize routes and webhooks`.
5. `feat(bonds): list intersected repositories`.
6. `feat(sessions): accept Bond-backed github_repository resources`.
7. `feat(runtime): deliver repository-scoped tokens through a git credential helper`.
8. `feat(bonds): open pull requests with the configured principal`.
   Includes the MCP Bond tool, co-author hook, and audit facts.
9. `feat(console): Connect GitHub and repository picker`.
10. `feat(sessions): enforce viewer access and follow-up policy`.

## Open questions

- Extension field name: `oma_credential`, or a vendor-prefixed key that
  matches other OMA extensions.
- Whether `github.pr_principal` is a workspace setting only, or can also be
  overridden per agent.
- Whether the helper should also serve legacy `authorization_token` resources
  in the same release.
- Whether GitHub Enterprise Server is a first-version requirement.
- Commit signing: create commits through the GitHub API with the
  installation token, sign in the sandbox with a per-deployment key, or keep
  unsigned commits. Which commits GitHub marks as Verified for an App bot
  needs a test before choosing.
