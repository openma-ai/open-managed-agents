# Workspace members

A workspace (tenant) can contain multiple users. In the Console, open **Members** under Configuration. Users share the workspace's resources; these roles govern member administration, not per-resource read/write permissions.

| Action | Owner | Admin | Member |
| --- | --- | --- | --- |
| View members | Yes | Yes | Yes |
| Invite ordinary members | Yes | Yes | No |
| Invite admins | Yes | No | No |
| Change admin/member roles | Yes | No | No |
| Remove ordinary members | Yes | Yes | No |
| Remove admins | Yes | No | No |
| Remove or demote owners | No | No | No |

Create an invitation link, copy it, and share it with the intended person. Anyone holding the link can sign in or register and explicitly accept it. Links are not bound to an email address, expire after seven days, and can be used once. Only the token hash is stored. Creating an invitation does not send email. Pending invitations can be revoked. Changing a creator's role or removing them invalidates their pending invitations. Accepting an invitation never upgrades an existing member's role.

Removal denies subsequent cookie requests to that workspace and user-bound API-key requests. Workspace keys without an associated user remain workspace credentials; rotate shared keys when removing someone who knows them. Owners are protected from removal or demotion; ownership transfer and per-resource permissions are outside this feature.

## API

All paths below are relative to `/v1/oma/tenants`. Requests require authenticated identity and the appropriate membership role. `{tenant}` is explicitly checked against the caller's membership.

| Method | Path | Body / result |
| --- | --- | --- |
| GET | `/{tenant}/members` | Members, caller role and user ID |
| PATCH | `/{tenant}/members/{user}` | `{ "role": "admin" }` or `member` |
| DELETE | `/{tenant}/members/{user}` | Removes a non-owner member |
| GET | `/{tenant}/invitations` | Pending invitations, without tokens |
| POST | `/{tenant}/invitations` | `{ "role": "member" }`; returns token once |
| DELETE | `/{tenant}/invitations/{id}` | Revokes a pending invitation |
| POST | `/invitations/accept` | `{ "token": "…" }`; returns `tenant_id` |

The Console's `/join#TOKEN` page preserves the invitation through sign-in. It does not pin acceptance to the previously active workspace, which may no longer be accessible.

## Deployment

Apply Cloudflare's `0023_tenant_invitations.sql` migration to **MAIN_DB**, where memberships live, before deploying the worker. Invitation storage must not be routed to a tenant resource shard. Node's SQLite and PostgreSQL startup migrators apply `0027_tenant_invitations.sql`; MySQL has an explicit snapshot upgrade for this additive table. Both runtime schema definitions and Drizzle snapshots are included.

Authentication must be enabled for user/member administration. An `AUTH_DISABLED` installation has no independently authenticated team identities.
