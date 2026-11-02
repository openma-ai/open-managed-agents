# ADR 0010: Self-managed GitLab Bonds, user principal by default

**Status**: Proposed (2026-10-12)

**Related**: [`0006-session-execution-authority.md`](0006-session-execution-authority.md),
[`0007-sandbox-credential-egress.md`](0007-sandbox-credential-egress.md),
[`0009-github-bonds.md`](0009-github-bonds.md),
OpenMatter [`docs/BONDS.md`](https://github.com/openma-ai/OpenMatter/blob/main/docs/BONDS.md)
and [`docs/IDENTITY_MODEL.md`](https://github.com/openma-ai/OpenMatter/blob/main/docs/IDENTITY_MODEL.md)

---

## Context

Some workspaces keep their code on GitLab, often on a self-managed instance
at a private hostname. They need the controls ADR 0009 gives GitHub:

- repository picking from the user's own access;
- per-repository and per-operation limits;
- no long-lived token in the sandbox;
- execution fencing, revocation, and audit.

By default no bot or service account is introduced: every GitLab operation
runs as the user who linked the account. A workspace may opt in to an app
principal backed by a bot credential that its administrator registers.

OMA has no GitLab repository resource today. The resolver handles only
`github_repository`
(`packages/managed-agents-application/src/sessions/resource-resolver-service.ts:131`).
The `glab` capability spec targets only `gitlab.com` and a placeholder device
flow client (`packages/cap/src/builtin/glab.ts`). ADR 0007 egress matches
credentials by hostname, not by project path.

GitLab facts were checked read-only against a self-managed GitLab 17.1.8
Enterprise Edition instance on 2026-10-12:

- **No App or installation concept.** OAuth applications are owned by the
  instance, a top-level group, or one user. Creating instance or group
  applications needs an administrator or a group Owner.
- **Grants.** OIDC discovery lists `authorization_code` with PKCE `S256` and
  `refresh_token`. GitLab documents device flow from 17.1, but this instance
  has no `device_authorization_endpoint`, and `POST /oauth/authorize_device`
  returns 404, so the feature is disabled there.
- **Account-wide scopes.** No scope narrows a user token to one project. The
  test account has Developer access or higher on 825 projects, and a
  `write_repository` token reaches all of them.
- **No narrower credential without a bot.** Project access tokens, group
  access tokens, and service accounts all create bot users. The instance
  already has many `project_<id>_bot_*` users. They are excluded by
  default, and a workspace may register one as an optional app principal
  ([App principal (optional)](#app-principal-optional)).
- **Git over HTTPS** accepts the token as the password with any username
  (`oauth2`, the login, or an arbitrary string all worked).
- **Path forms vary.**
  - Git paths are case-insensitive.
  - A git path without `.git` answers 301 to the `.git` form.
  - REST accepts a numeric project ID or a case-insensitive URL-encoded path,
    and returns 404 for a `.git` suffix.
  - `/api/graphql` serves all projects from one endpoint.
- **No delegation marker.** Merge requests expose no field that marks
  app-mediated creation.
- **Private network.** The instance hostname resolves to a private address
  that is reachable from a corporate workstation. TLS uses a public CA.

## Decision

### Equivalence target

| ADR 0009 control | This ADR |
| --- | --- |
| repository-scoped, 1 h installation token reaches the sandbox | no provider token reaches the sandbox; a control-plane git proxy uses the resolved principal's token per request |
| App permissions | operation classes `fetch`, `push`, `open_mr`, `comment_mr` |
| repository picker over installation ∩ user | `GET /projects?membership=true&min_access_level=30&search=` |
| access check at Session creation | `GET /projects/:id`, highest of `project_access` and `group_access` |
| installation and authorization webhooks | none; refresh or request failure marks the link |
| PR opened "with App" | user-authored with content marker and audit fact; bot-authored with "Requested by" in app mode |
| `pr_principal` with explicit fallback | `principal_policy`: `user_only` by default; `user` and `app` once a bot credential is registered |
| one way to link (App authorization) | `link_methods` policy: OAuth, personal access token, or both |
| app principal for automations | none by default; an optional registered bot credential, otherwise unattended GitLab work is rejected |

Enforcement sits in the application, not the network. It therefore works on
every sandbox provider, including those that ADR 0007 rates `advisory`. A
process that bypasses the proxy and connects to GitLab directly holds no
GitLab credential.

### Provider instances

A workspace administrator registers each GitLab instance:

```text
bond_provider_apps
  id, workspace_id, provider ('gitlab'), base_url (canonical https origin),
  link_methods ('pat_only' | 'oauth_only' | 'oauth_preferred'),
  oauth_client_id (nullable), oauth_client_secret_cipher (nullable),
  cipher_key_id, max_pat_lifetime_days (default 90),
  identity_binding ('none' | 'sso_extern_uid'), sso_provider (nullable),
  ca_bundle (nullable PEM), scopes, mr_mode ('push_options' | 'api'),
  allow_user_principal_output (bool, default false),
  principal_policy ('user_only' | 'user' | 'app', default 'user_only'), status,
  created_by_user_id, created_at, updated_at
  unique (workspace_id, base_url)
```

- gitlab.com is an instance like any other.
- `allow_user_principal_output` must be true before any write by a user
  principal. This is the administrator opt-in required by OpenMatter
  IDENTITY_MODEL. Writes by the app principal do not need it.
- `principal_policy` other than `user_only` requires a registered bot
  credential ([App principal (optional)](#app-principal-optional)).
- `ca_bundle` supports private CAs.

### Link method policy

`link_methods` decides how users may link. It is a policy in the same sense
as `PrincipalPolicy`: the administrator configures it, the user chooses
explicitly, and nothing switches silently.

| Policy | User sees | Requires |
| --- | --- | --- |
| `pat_only` | paste a personal access token | nothing; the default when no OAuth application is registered |
| `oauth_only` | authorize with GitLab | a registered OAuth application |
| `oauth_preferred` | authorize with GitLab, with "paste a token" under Advanced | a registered OAuth application |

Rules:

1. The link records `method` (`oauth` or `pat`). Audit facts carry it.
2. A failed OAuth refresh moves the link to `refresh_failed`. The user then
   re-links with any allowed method. The host never asks for a token in place
   of a failed OAuth link on its own.
3. Each user has at most one active link per instance. Linking again, by
   either method, revokes the previous link first.
4. Tightening the policy, for example from `oauth_preferred` to
   `oauth_only`, marks existing links of the removed method
   `method_disallowed`. Their tokens are revoked, and users re-link at next
   use.
5. Everything after linking is method-independent. The proxy, fence,
   attribution, and audit resolve the link, not the credential type.

When an OAuth method is enabled:

- registration reads `/.well-known/openid-configuration`. It fails unless
  PKCE `S256` and `refresh_token` are supported and the issuer equals
  `base_url`;
- an instance-level application is recommended. A top-level group
  application also works. A user-owned application is accepted with a
  warning, because it disappears with its owner;
- the redirect URI is
  `${GATEWAY_ORIGIN}/v1/oma/bonds/{bondId}/callback`, the generic Bond
  callback from ADR 0011
  (`apps/main-node/src/config.ts:283`);
- the client secret uses
  `secrets.cipherFor("bonds.gitlab.client_secrets")`.

### Linking

Common to both methods:

- The consent screen states that commits and merge requests will appear
  under the user's own GitLab account and carry an OpenMA marker. The user's
  consent is recorded.
- The host reads `GET /user` (ID, username, name, `commit_email`,
  `identities`). The numeric user ID is the stable key. Username and email are
  display data.
- With `identity_binding = 'sso_extern_uid'`, the `extern_uid` of the
  identity whose provider equals `sso_provider` must equal the OMA user's SSO
  subject. Otherwise linking fails with `gitlab_identity_mismatch`. This stops
  a user from linking someone else's or a shared account.
- One GitLab user ID may hold only one active link per workspace.
- The link is stored in `bond_user_links` from ADR 0009, with
  `provider_app_id` set to the instance's `bond_provider_apps.id` and
  `method` set. Tokens use
  `secrets.cipherFor("bonds.gitlab.user_tokens")`.
- The allowed scopes are `read_user read_api write_repository`, plus `api`
  only when `mr_mode = 'api'`.

OAuth (`method = 'oauth'`):

1. The host creates a signed, single-use state bound to the user and
   provider, and a PKCE verifier.
2. The callback exchanges the code and requests only the allowed scopes.
3. Access tokens last 2 hours. Each refresh invalidates both the old access
   token and the old refresh token, so refresh must be single-flight. It runs
   under the OpenMatter refresh lease, and the rotated pair is committed under
   that lease. A rejected refresh moves the link to `refresh_failed`.
4. Unlink calls `POST /oauth/revoke` and writes a tombstone.

Personal access token (`method = 'pat'`):

1. The console offers a link to the instance's token page with the name and
   allowed scopes prefilled. The token is submitted through a dedicated form,
   never through chat or Session input.
2. The host calls `GET /personal_access_tokens/self`. It rejects the token
   when the token is inactive, has a scope outside the allowed set, has no
   expiry, or expires later than `max_pat_lifetime_days` from now.
3. There is no refresh. The host warns the user 7 days before `expires_at`. An
   expired or rejected token moves the link to `expired` or `refresh_failed`,
   and the user pastes a new one.
4. Unlink calls `DELETE /personal_access_tokens/self` and writes a tombstone.

### App principal (optional)

An administrator may register one bot credential per instance. It becomes
the instance's Installation in OpenMatter terms and enables the `app` and
`user` principal policies.

| `principal_policy` | Attended Session | Unattended Session |
| --- | --- | --- |
| `user_only` (default) | creator's link; `gitlab_link_required` without one | rejected with `gitlab_unattended_unsupported` |
| `user` | creator's link; the app principal, recorded as fallback, without one | app principal |
| `app` | app principal | app principal |

Credential:

- A group access token is preferred. A project access token or a service
  account's personal access token is also accepted. Creating a group access
  token needs the group Owner role. Service accounts need an administrator.
- It is stored in `bond_installations` from ADR 0009 with
  `provider_app_id` set to the instance's `bond_provider_apps.id`,
  `provider_installation_id` set to the bot's GitLab user ID, and the token
  in a new nullable `credential_cipher` column, sealed with
  `secrets.cipherFor("bonds.gitlab.app_tokens")`. Each instance holds
  at most one active credential. ADR 0009's claim and release rules apply.
- Registration calls `GET /personal_access_tokens/self` and `GET /user`. It
  rejects the token when it is inactive, has no expiry, has a scope outside
  `read_api write_repository` (plus `api` when `mr_mode = 'api'`), or when
  `/user` does not report `bot: true`. A human account's token is never
  accepted as an app principal.
- The console warns administrators 14 days before `expires_at`. An expired
  or rejected credential moves the Installation to `refresh_failed`, and
  Sessions that resolve to the app principal fail with
  `gitlab_app_not_configured`. Self-rotation is not used yet (see Open
  questions).
- The bot token never reaches the sandbox. The git proxy uses it in the same
  way as a user token.

Access:

- The bot reaches only the group or project the token was created for, with
  the token's role.
- When the creator holds a link, access is the intersection of the bot's
  access and the creator's access. The creator's token is used only for the
  access check at Session creation and in the picker.
- Without a creator link (unattended Sessions, `app`, or a `user` fallback),
  access is the bot's access. The administrator accepts this by choosing the
  policy, and controls it by choosing the token's group or project and role.

Attribution with the app principal:

| Artifact | Author | Marker |
| --- | --- | --- |
| Commits | the bot's name and email | `Assisted-by: OpenMA <Session URL>`; `Co-authored-by` for the requesting user when that user holds a link |
| Merge request | the bot | label `openma` and a description footer with "Requested by @user" and the Session link |
| Comments (`api` mode) | the bot | the same footer |

The bot is a visible non-human GitLab identity, so app-principal output does
not rely on the IDENTITY_MODEL exception for user-principal output.

### Session resource

OMA uses the provider-neutral `oma_bond_resource` from ADR 0011. Claude
Managed Agents shapes are not changed (ADR 0007, "Preserve the official
protocol exactly").

```jsonc
{
  "type": "oma_bond_resource",
  "bond_id": "bond_...",        // the instance's bond_provider_apps row
  "resource": "project:42",
  "operations": ["fetch", "push", "open_mr"],
  "options": { "checkout": { "type": "branch", "name": "main" } }
}
```

The steps below are the GitLab binding's `validate`. The agent's
`bond_grants` must also cover the project and operations (ADR 0011, "Access
rule").

At creation the resolver:

1. resolves the principal from `principal_policy`. A user principal needs
   an authenticated creator (`managed_sessions.created_by_user_id`, ADR 0009)
   and that creator's active link for the Bond;
2. reads `GET /projects/:id` and requires access level 20 (Reporter) for
   `fetch`, or 30 (Developer) for `push`, `open_mr`, and `comment_mr`. It
   checks with the creator's token when the creator holds a link, and also
   with the bot token when the principal is the app;
3. rejects user-principal write operations unless
   `allow_user_principal_output` is true;
4. rejects unattended Sessions (schedules, webhooks, shared channels, API
   keys without a user) unless an app principal is configured and the policy
   is `user` or `app`;
5. stores a sealed reference `{bondId, principal, userLinkId?,
   installationId?, projectId, operations}`. The project path is display
   data, refreshed by ID, and never an authority.

Errors: `gitlab_provider_not_configured`, `gitlab_link_required`,
`gitlab_identity_mismatch`, `gitlab_link_method_disallowed`,
`gitlab_project_not_accessible`, `gitlab_user_output_disabled`,
`gitlab_unattended_unsupported`, `gitlab_app_not_configured`,
`gitlab_refresh_failed`.

The GitLab binding's `list` backs the generic
`GET /v1/oma/bonds/{bondId}/resources?query=` picker. It uses the creator's token, pages through `x-total`, and
caches briefly per link.

### Git proxy

The control plane serves git smart HTTP at
`/v1/oma/git/{sessionId}/{resourceId}.git/...`, beside the existing Layer-A
routes.

Sandbox setup during Session input preparation:

- `url."<OMA origin>/v1/oma/git/<session>/<resource>.git".insteadOf` for the
  project's `.git` and suffix-less URLs. Other spellings go directly to
  GitLab without credentials and fail.
- A credential helper scoped to the OMA origin returns the Session's current
  Work capability (ADR 0006), following the `sessions_token` rules in ADR
  0007. It is never sent to the GitLab host.

Per request the proxy:

1. validates the capability and the active fence generation, and rejects
   stale or replayed capabilities;
2. maps `{sessionId, resourceId}` to the stored numeric project and builds
   the upstream URL itself. The client never supplies an upstream path;
3. allows only `info/refs?service=git-upload-pack` and `git-upload-pack`. It
   also allows `info/refs?service=git-receive-pack` and `git-receive-pack`
   when `push` is granted. LFS, archive, and every other route are denied;
4. parses the receive-pack command list without buffering the pack. It denies
   tag pushes, ref deletions, and pushes to the project's default branch.
   GitLab's own protection is not enough here: on the test instance, `main`
   allows Maintainers to push, so a Maintainer's token could update it. It denies push options other than the
   `merge_request.*` options needed by `open_mr`. GitLab still enforces
   protected branches against the user's permission;
5. never follows upstream redirects. A rename resolves through a project ID
   refresh, not a redirect;
6. streams with size and time limits, and logs binding ID, project ID,
   operation, refs, status, and latency. Tokens and bodies are never logged.

GraphQL and arbitrary REST from the sandbox are not proxied. In-sandbox `glab`
is out of scope.

### Merge requests and comments

- `mr_mode = 'push_options'` (default) creates merge requests with
  `git push -o merge_request.create -o merge_request.target=<branch>` through
  the proxy. Only `write_repository` is needed. The proxy requires
  `merge_request.label=openma` on any push that creates a merge request.
- `mr_mode = 'api'` adds the `api` scope and a host-side Bond tool on
  the MCP proxy for opening merge requests and commenting (`comment_mr`). The
  token still stays in the control plane.

### Attribution

| Artifact | Author | Marker |
| --- | --- | --- |
| Commits | creator's GitLab name and `commit_email`, written into the sandbox git config by the host | `Assisted-by: OpenMA <Session URL>` from a `prepare-commit-msg` hook; `Co-authored-by` for participants who hold their own link on the same instance |
| Push | creator | proxy audit fact |
| Merge request | creator | label `openma` and a description footer with the Session link |
| Comments (`api` mode) | creator | footer with the Session link |

This table covers the user principal. App-principal attribution is in
[App principal (optional)](#app-principal-optional).

Each write emits an audit fact containing principal kind (`user` or `app`),
link ID or installation ID, fallback flag and reason, provider ID, project
ID, operation, refs or MR IID, Session, Work, and fence generation.

### Multi-user Sessions

- App principal: follow-ups from other users follow ADR 0009's
  `sessions.followups_from_others`. Writes appear under the bot, and the
  footer names the requesting user.
- User principal: writes run as the creator. Follow-ups from other users are
  denied, whatever `sessions.followups_from_others` says. Otherwise one user
  could steer writes that appear under another person's account.
- Workspace setting `gitlab.mr_principal_participants` (default `false`)
  mirrors ADR 0009's `github.pr_principal_participants`. When it is true, a
  follow-up from another user is accepted under a user principal only if
  `sessions.followups_from_others` allows it and that user holds an active
  link on the instance. Pushes, merge requests, and comments prompted by
  that input run as that user, and the audit fact records the participant.

### Network reach

The control plane must reach each registered instance for token exchange,
refresh, and git proxying. A private instance needs OMA deployed inside that
network or behind a relay that terminates there. `ca_bundle` supports private
CAs.

## Compatibility

- Claude Managed Agents resources and `authorization_token` behave as before.
- `oma_bond_resource` for a GitLab Bond is rejected by deployments without a
  registered instance.
- The `glab` capability spec is unchanged.

## Verification gates

Run against a self-managed instance in an opt-in lane:

1. With an OAuth method enabled, registration rejects an origin without PKCE
   `S256`, or one whose issuer does not match.
2. Linking stores sealed tokens. No user token appears in Session events,
   logs, sandbox environment, process listings, or API responses.
3. The picker lists only Developer-or-higher projects. A non-member project is
   rejected at Session creation.
4. Clone, fetch, and push through the proxy succeed. A direct GitLab URL from
   the sandbox carries no credential. A proxy path for another resource
   returns 403.
5. Tag pushes, ref deletions, and unknown push options are denied. A protected
   branch rejection from GitLab reaches git intact.
6. A push-option merge request has label `openma`. Commits carry the creator
   as author and the `Assisted-by` trailer.
7. A stale fence generation and a capability replayed from another Session
   are rejected.
8. Unlink revokes the grant. Parallel refreshes produce one committed
   rotation.
9. With `user_only`, unattended Sessions, and follow-ups from other users
   while `gitlab.mr_principal_participants` is false, are rejected for GitLab
   resources.
10. GraphQL, REST, LFS, and redirects through the proxy are denied.
11. A personal access token with an extra scope, no expiry, or an expiry
    beyond `max_pat_lifetime_days` is rejected. An accepted token works
    through the same proxy path as an OAuth link.
12. Each `link_methods` value shows only its allowed methods. Tightening the
    policy marks and revokes links of the removed method. A failed OAuth
    refresh never turns into a token prompt on its own.
13. With `sso_extern_uid`, linking an account whose SSO identity differs from
    the OMA user fails with `gitlab_identity_mismatch`.
14. Registering an app credential rejects a human account's token, a token
    without expiry, and a token with an extra scope. `principal_policy =
    'app'` without a credential fails with `gitlab_app_not_configured`.
15. With the app principal, an unattended Session pushes and opens a merge
    request authored by the bot, with the "Requested by" footer and the
    `Co-authored-by` trailer. The bot token never appears in the sandbox.
16. With the app principal, an attended Session whose linked creator cannot
    reach a project that the bot can reach is rejected with
    `gitlab_project_not_accessible`.
17. With `user`, a creator without a link resolves to the app principal, and
    the audit fact records the fallback and its reason.

## Consequences

Positive:

- GitLab gets ADR 0009's per-project, per-operation, fenced, revocable,
  audited control without a bot account by default.
- Workspaces that need unattended work, or prefer a non-human author, can
  register a bot credential without changing the proxy or the resource.
- Enforcement does not depend on the sandbox provider's network features.
- `pat_only` works without an administrator or an OAuth application, so a
  workspace can start immediately and move to OAuth later.

Negative:

- All git traffic passes through the control plane. Large repositories cost
  bandwidth and need limits.
- User tokens are account-wide. Host key compromise exposes more than the
  GitHub equivalent would.
- The content marker is weaker than GitHub's "with App". It relies on the
  OpenMatter IDENTITY_MODEL exception.
- Unattended GitLab work needs an administrator-registered bot credential.
  Without one it is rejected. There is no in-sandbox `glab`.
- Bot credentials expire, at most one year after creation on current GitLab
  defaults, and OMA does not rotate them yet. An administrator replaces
  them by hand.
- Private instances constrain where OMA can be deployed.
- OMA depends on `@openma/matter` (for `/bond`) and `@openma/matter-gitlab`, installed
  from npm at the same version as the GitHub packages in ADR 0009.
- Personal access tokens are long-lived and are not rotated by OMA. A stolen
  one stays valid until it expires or is revoked. The lifetime cap and
  unlink-time revocation limit the exposure.

## Delivery plan

Each step is one small PR with the evidence report required by
`CONTRIBUTING.md`:

1. `docs(adr): add 0011 Matter, and rename 0009 and 0010 to Bonds`. This
   lands with ADR 0009 and ADR 0011, after the OpenMatter IDENTITY_MODEL
   amendment.
2. `feat(main-node): add bond_provider_apps table, provider_app_id and
   method on links`.
   Includes migrations for PostgreSQL, MySQL, and SQLite, and the conformance
   suite.
3. `feat(bonds): register GitLab instances and link method policy`.
   Adds the API and console screens.
4. `feat(bonds): add GitLab personal access token linking with scope and
   expiry checks`.
5. `feat(bonds): add GitLab OAuth PKCE link, refresh, and unlink`.
6. `feat(gitlab): implement the GitLab resource catalog` for the
   `oma_bond_resource` type and picker from ADR 0011.
7. `feat(main-node): add fenced git smart HTTP proxy with project and ref
   policy`.
8. `feat(sandbox): configure insteadOf, the capability helper, and the commit
   hook`.
9. `feat(bonds): add push-option merge requests and opt-in api mode`.
10. `feat(bonds): add GitLab app principal from a registered bot
    credential`.
11. `test(bonds): add self-managed GitLab live lane`.

## Open questions

- Whether to restrict pushed branches further, to a prefix such as `openma/`.
- LFS support.
- Relay design for hosted OMA reaching private instances.
- Whether `max_pat_lifetime_days` should default lower than 90.
- Bot credential rotation. On 17.1.8 a bot cannot rotate its own token
  (see Prototype results). A human Maintainer can rotate it, and the bot
  user stays the same. Options are manual replacement by an administrator,
  rotation by a human-held token kept only in the control plane, or the
  narrower `self_rotate` scope where the instance version supports it.

## Prototype results

A test-only proxy prototype, kept outside this repository, ran the flow against the self-managed 17.1.8 instance
on 2026-10-12. It used one test branch and one merge request, both cleaned
up afterwards. All 21 checks passed:

- the sandbox environment held no GitLab token, and a direct GitLab request
  from it failed authentication;
- clone with the original URL went through `insteadOf` to the proxy, using
  protocol v2 fetch. The stored remote URL stayed the GitLab URL;
- a wrong capability returned 401. An unknown resource, another Session's
  path, push on a fetch-only resource, `/api/v4/*`, `/api/graphql`, LFS, and
  a `..` traversal each returned 403;
- the proxy denied pushes to the default branch, tag pushes, branch
  deletions, `ci.skip`, and `merge_request.create` without
  `merge_request.label=openma`. None of these reached GitLab;
- a push with `merge_request.create`, `target`, `title`, `description`, and
  `label=openma` created a merge request authored by the user. GitLab
  created the missing project label `openma` automatically;
- commits carried the user's name and `commit_email` and the `Assisted-by`
  trailer;
- after the capability rotated, the next fetch was rejected;
- no token appeared in proxy logs or the work directory.

### Sandbox and OAuth run

A second run on 2026-10-12 used two sandboxes from the provider's test
template with the OMA worker image. Sandbox P stood in for the control plane:
it ran the proxy and held a 2-hour OAuth token. Sandbox A was the agent and
held only the Session capability. A reached P through the provider's
per-port HTTPS host. The test merge request and branch were cleaned up
afterwards.

- Network: from the test template, the instance resolved to a VPC address and
  answered in about 0.2 s. gitlab.com was also reachable.
- OAuth on the instance, using an application owned by one user:
  - authorization code with PKCE `S256` worked;
  - a wrong `code_verifier` was refused without consuming the code;
  - `expires_in` was 7200, and `/oauth/token/info` showed exactly the
    requested scopes;
  - without `api`, a REST write was refused with 403, while `read_user` and
    the project picker worked;
  - a refresh returned a new pair, and the old access token then failed with
    401;
  - reusing the rotated-out refresh token was refused. It did **not** revoke
    the current pair, so GitLab offers no reuse detection. The refresh lease
    is the only guard against concurrent refresh;
  - `/oauth/revoke` invalidated both the access token and the refresh token.
- Redirect URI: a loopback `redirect_uri` with a different port was
  **accepted** at token exchange, and the exchange consumed the code. This
  matches the RFC 8252 loopback rule. Hosted OMA must therefore register an
  HTTPS redirect URI, not a loopback one. Desktop hosts must bind the state
  and PKCE verifier to their own listener.
- Agent sandbox, 16 checks:
  - no GitLab token in the environment, and a direct GitLab git request
    returned 401;
  - clone through the proxy worked;
  - a wrong capability returned 401, while another Session, push on a
    fetch-only resource, REST, GraphQL, and LFS returned 403;
  - pushes to the default branch, tags, deletions, and merge requests
    without `label=openma` were denied;
  - a push-option merge request was created and authored by the user, and
    commits carried the `Assisted-by` trailer;
  - a rotated capability was rejected;
  - no token appeared in the proxy log or agent output.

  One filesystem scan reported a match. It was the test script matching its
  own search pattern, and the cloned repository contains no token-like
  strings.

### App principal run

A third run on 2026-10-12 used a project access token with the Developer
role and `read_api write_repository` as the bot credential. The token was
created, rotated, and revoked by a human Maintainer during the run.

- Registration checks:
  - `GET /personal_access_tokens/self` returned the scopes and `expires_at`;
  - `GET /user` returned `bot: true`;
  - the bot saw exactly one project;
  - without `api`, a REST write was refused with 403.
- Rotation:
  - bot self-rotation failed in every form: `insufficient_scope` without
    `api`; 403 with `api`, even with the Maintainer role; and 401 on
    `POST /projects/:id/access_tokens/self/rotate`;
  - `POST /projects/:id/access_tokens/:id/rotate` by a human Maintainer
    returned 200. The bot user stayed the same, and the old token failed
    with 401 at once;
  - revoking the project access token blocked its bot user.
- Proxy run with the bot credential, 8 checks:
  - a project the user could reach but the bot could not returned 404 for
    the bot, so the intersection rule rejected it;
  - clone through the proxy worked;
  - commits carried the bot as author, plus the `Assisted-by` and
    `Co-authored-by` trailers;
  - a push to the default branch was denied by the proxy;
  - the push-option merge request was authored by the bot, had label
    `openma`, and its description carried "Requested by @user";
  - no token appeared in the proxy log.

The test merge request, branch, label, and tokens were removed afterwards.

### OpenMatter Bond run

A fourth run on 2026-10-12 drove `@openma/matter/bond` with
`@openma/matter-gitlab/bond` through the loopback example in OpenMatter
(`examples/gitlab-bond-local`). All 11 checks passed:

- instance discovery succeeded and reported no device flow;
- authorization code with PKCE returned `read_user read_api
  write_repository`;
- the store held only sealed tokens, and the credential resolved to the
  linked user;
- six concurrent credential calls caused one refresh, and all six received
  the rotated token. The old access token then failed with 401, and the new
  one worked;
- unlink revoked the grant on GitLab, the token failed with 401, and the
  next credential call returned `link_required`.

The run found a defect: when the refresh skew exceeded the token lifetime,
each waiting caller refreshed again, so six concurrent calls caused six
refreshes. The kernel now reuses a token that another caller rotated while
it waited, and a regression test covers the case.

A second authorization for the same application and scopes redirected to
the callback without showing the consent page. The signed `state` and PKCE
verifier, not the consent page, bind a callback to the linking user.

## Unverified on the test instance

- prefilled `scopes` on the token page. The prefilled `name` was confirmed;
- `DELETE /personal_access_tokens/self` with only the allowed scopes;
- exact matching for a non-loopback HTTPS redirect URI;
- `GET /personal_access_tokens/self` and `bot: true` from `/user` for a
  group access token. Creating one needs the group Owner role, which the
  test account does not hold.
