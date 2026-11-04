# Strict issue #448 acceptance

All 22 source images in `/workspace/cma-deployments-ui/` were individually opened and inspected. Each PNG below is the real OMA Console with intercepted API fixtures, not a rebuilt reference. Composites are reference left / OMA right at `/tmp/448-accept/01.png` through `22.png`.

Viewport: 01 = 1280×800; 03 = 1910×1115; 04 = 1910×1405; all others = 1920×1072. The clock is fixed at 2026-11-03 07:00 America/Chicago so all five previews match. Reference 01 includes browser/desktop chrome; OMA capture is the requested browser viewport.

The existing OMA shell, navigation groups, workspace/user controls, fonts, colors, icons, and Radix component appearance are retained. Claude billing, documentation, notifications, and migration-feedback chrome belong to the reference product shell, not the Deployments/Sessions/Environments feature. Product names are adapted to OMA. PASS below means the feature information architecture, controls, copy, menu options and behavior match, with those explicitly stated OMA presentation adaptations; it does not claim pixel equality.

## Before this continuation

- Deployment creation already had the three sections, schedule presets, GitHub and memory resource forms, and unsaved-change protection. Agent/environment pickers used generic search/empty text; the vault empty picker lost its search field. The memory management link was below a duplicate card label. File resources only selected existing uploads, without Upload / File ID modes or drop target.
- Lists placed creation/search differently. They lacked visible row-selection checkboxes. Sessions had no deployment or creator filter, defaulted to all statuses, lacked cost/token/creator/action columns, and used different empty copy. Environments showed Status/Created instead of Scope/Updated at/Archived at and lacked the reference description.
- All these supported differences have been corrected. The specific unsupported timing claim is G1 below.

## API evidence and remaining gaps

**G1 — bounded schedule jitter (screenshot 10, FAIL).** `packages/managed-agents-api/src/contracts/deployments.ts` exposes cron expression, timezone, last run and upcoming target times, but no jitter/window fields or timing guarantee. `packages/managed-agents-adapters-runtime/src/deployment-schedule-planner.ts` uses Croner `nextRuns(5, after)`; it does not compute minute-level 9-second or hourly 9-minute windows. The UI therefore says “Times shown are targets, not exact start times.” It cannot truthfully reproduce the full reference tooltip’s timing bounds through the existing API. No endpoint or scheduling behavior was invented.

`packages/managed-agents-api/src/routes/sessions.ts` and `contracts/sessions.ts` accept `deployment_id`, agent, time bounds, `statuses[]`, and `include_archived`. Active is derived from nonarchived/nonterminated sessions, loading remaining pages. The all-sessions action sets `include_archived=true`. Session `usage` exposes `list_cost`, `input_tokens` and `output_tokens`; absent cost is shown as unpriced, not fabricated.

**Creator provenance limitation (not a screenshot blocker):** neither session nor deployment list API provides an authoritative creator identity or a creator query. The Console writes/reads `metadata.created_by`; missing provenance stays “—”, and filtering scans loaded pages (loading remaining pages). It cannot infer historical authors from IDs. The empty-state references only require the Anyone control, which is present.

`apps/main/src/routes/files.ts` supports multipart `POST /v1/files`; `managedApi.files.upload` uses that route, and returned IDs are sent in the existing deployment resources array. Upload errors keep the draft available for retry. Environment contracts/mappers expose `scope`, `updated_at`, `archived_at`; no derived API endpoints were added.

## Results

| NN | State | Result |
| --- | --- | --- |
| 01 | [deployments-list-empty](01-deployments-list-empty.png) | PASS |
| 02 | [deployments-list-skeleton-columns](02-deployments-list-skeleton-columns.png) | PASS |
| 03 | [create-deployment-manual](03-create-deployment-manual.png) | PASS |
| 04 | [create-deployment-schedule](04-create-deployment-schedule.png) | PASS |
| 05 | [create-frequency-menu](05-create-frequency-menu.png) | PASS |
| 06 | [create-agent-empty](06-create-agent-empty.png) | PASS |
| 07 | [create-environment-picker](07-create-environment-picker.png) | PASS |
| 08 | [create-vault-empty](08-create-vault-empty.png) | PASS |
| 09 | [create-add-resource-menu](09-create-add-resource-menu.png) | PASS |
| 10 | [schedule-jitter-tooltip](10-schedule-jitter-tooltip.png) | FAIL (G1) |
| 11 | [create-custom-cron](11-create-custom-cron.png) | PASS |
| 12 | [resource-github](12-resource-github.png) | PASS |
| 13 | [resource-file-upload](13-resource-file-upload.png) | PASS |
| 14 | [resource-memory](14-resource-memory.png) | PASS |
| 15 | [github-checkout-options](15-github-checkout-options.png) | PASS |
| 16 | [github-branch-fields](16-github-branch-fields.png) | PASS |
| 17 | [unsaved-changes-dialog](17-unsaved-changes-dialog.png) | PASS |
| 18 | [memory-access](18-memory-access.png) | PASS |
| 19 | [sessions-list-skeleton](19-sessions-list-skeleton.png) | PASS |
| 20 | [sessions-empty](20-sessions-empty.png) | PASS |
| 21 | [sessions-deployment-filter](21-sessions-deployment-filter.png) | PASS |
| 22 | [environments-list](22-environments-list.png) | PASS |

Overall: **FAIL — 21 PASS, 1 FAIL (G1)**. All API-supported feature differences in the supplied states are implemented.

## 01 — deployments-list-empty — PASS

| Element | Reference | OMA | Match / differs / missing |
| --- | --- | --- | --- |
| Heading | Deployments | Deployments | match |
| Description | A deployment binds an agent to credentials, an environment, and a schedule so it can run on its own. | A deployment binds an agent to credentials, an environment, and a schedule so it can run on its own. | match |
| Heading action | Create deployment (plus icon) | Create deployment (plus icon) | match |
| Search | Search by name or exact ID | Search by name or exact ID | match |
| Filters in order | Created by: Anyone; Agent: All; Status: Active | Created by: Anyone; Agent: All; Status: Active | match |
| Empty title | No deployments | No deployments | match |
| Empty copy | A deployment binds an agent to an environment, credentials, and a schedule so it can run on its own. | A deployment binds an agent to an environment, credentials, and a schedule so it can run on its own. | match |
| Empty action | Create deployment | Create deployment | match |
| Empty illustration | Calendar | OMA calendar/clock icon | match (OMA icon styling) |

## 02 — deployments-list-skeleton-columns — PASS

| Element | Reference | OMA | Match / differs / missing |
| --- | --- | --- | --- |
| Heading | Deployments | Deployments | match |
| Description | A deployment binds an agent to credentials, an environment, and a schedule so it can run on its own. | A deployment binds an agent to credentials, an environment, and a schedule so it can run on its own. | match |
| Heading action | Create deployment (plus icon) | Create deployment (plus icon) | match |
| Search | Search by name or exact ID | Search by name or exact ID | match |
| Filters in order | Created by: Anyone; Agent: All; Status: Active | Created by: Anyone; Agent: All; Status: Active | match |
| Column sequence | Selection checkbox; ID; Name; Agent; Trigger; Created by; Created; row actions | Selection checkbox; ID; Name; Agent; Trigger; Created by; Created; row actions | match |
| Loading state | 10 rows, placeholder in each column; no empty message | 10 rows, placeholder in each column; no empty message | match |

## 03 — create-deployment-manual — PASS

| Element | Reference | OMA | Match / differs / missing |
| --- | --- | --- | --- |
| Page heading | Create deployment | Create deployment | match |
| Page description | Deploy an agent with a trigger, environment, and credentials. | Deploy an agent with a trigger, environment, and credentials. | match |
| Bottom actions | Cancel; Create deployment; stays available when scrolling | Cancel; Create deployment; stays available when scrolling | match |
| General section | General; What this deployment runs and where. | General; What this deployment runs and where. | match |
| Name | Name; Nightly inbox triage placeholder | Name; Nightly inbox triage placeholder | match |
| Agent field | Agent; Select an agent; Manage agents external link | Agent; Select an agent; Manage agents external link | match |
| Environment field | Environment; Select an environment; Manage environments external link | Environment; Select an environment; Manage environments external link | match |
| Initial message | Initial message; Summarize today’s support tickets and post to #digest | Initial message; Summarize today’s support tickets and post to #digest | match |
| Message help | Sent to the agent at the start of every run. (below textarea) | Sent to the agent at the start of every run. (below textarea) | match |
| Budget | Budget (optional); $ input; no limit when empty | Budget (optional); $ input; no limit when empty | match |
| Budget help | Stop the session once it reaches this cost, priced at public list rates. Leave empty for no limit. Agents may occasionally exceed the budget by at most one turn. | Stop the session once it reaches this cost, priced at public list rates. Leave empty for no limit. Agents may occasionally exceed the budget by at most one turn. | match |
| Trigger section | Trigger; Start runs on demand or on a schedule. | Trigger; Start runs on demand or on a schedule. | match |
| Trigger choices | Manual (hand); Schedule (calendar); Manual selected | Manual (hand); Schedule (calendar); Manual selected | match |
| Manual explanation | Trigger runs from this Console with the Run now button, or via the API with POST /v1/deployments/:id/run. | Trigger runs from this Console with the Run now button, or via the API with POST /v1/deployments/:id/run. | match |
| Resources section | Resources; Credentials and resources available to each run. | Resources; Credentials and resources available to each run. | match |
| Vault field | Credential vaults (optional); Manage credential vaults external link; Add vault (+) | Credential vaults (optional); Manage credential vaults external link; Add vault (+) | match |
| Session resources | Session resources (optional); Files, GitHub repositories, or memory stores mounted into each run’s session. | Session resources (optional); Files, GitHub repositories, or memory stores mounted into each run’s session. | match |
| Resource action | Add resource with dropdown arrow | Add resource with dropdown arrow | match |

## 04 — create-deployment-schedule — PASS

| Element | Reference | OMA | Match / differs / missing |
| --- | --- | --- | --- |
| Page heading | Create deployment | Create deployment | match |
| Page description | Deploy an agent with a trigger, environment, and credentials. | Deploy an agent with a trigger, environment, and credentials. | match |
| Bottom actions | Cancel; Create deployment; stays available when scrolling | Cancel; Create deployment; stays available when scrolling | match |
| General section | General; What this deployment runs and where. | General; What this deployment runs and where. | match |
| Name | Name; Nightly inbox triage placeholder | Name; Nightly inbox triage placeholder | match |
| Agent field | Agent; Select an agent; Manage agents external link | Agent; Select an agent; Manage agents external link | match |
| Environment field | Environment; Select an environment; Manage environments external link | Environment; Select an environment; Manage environments external link | match |
| Initial message | Initial message; Summarize today’s support tickets and post to #digest | Initial message; Summarize today’s support tickets and post to #digest | match |
| Message help | Sent to the agent at the start of every run. (below textarea) | Sent to the agent at the start of every run. (below textarea) | match |
| Budget | Budget (optional); $ input; no limit when empty | Budget (optional); $ input; no limit when empty | match |
| Budget help | Stop the session once it reaches this cost, priced at public list rates. Leave empty for no limit. Agents may occasionally exceed the budget by at most one turn. | Stop the session once it reaches this cost, priced at public list rates. Leave empty for no limit. Agents may occasionally exceed the budget by at most one turn. | match |
| Trigger section | Trigger; Start runs on demand or on a schedule. | Trigger; Start runs on demand or on a schedule. | match |
| Trigger choices | Manual (hand); Schedule (calendar); Schedule selected | Manual (hand); Schedule (calendar); Schedule selected | match |
| Frequency and timezone | Frequency; Weekdays; Timezone; (GMT-06:00) America/Chicago | Frequency; Weekdays; Timezone; (GMT-06:00) America/Chicago | match |
| Next runs heading | Next 5 runs; information tooltip trigger | Next 5 runs; information tooltip trigger | match |
| Next run dates | Tue Nov 3, Wed Nov 4, Thu Nov 5, Fri Nov 6, Mon Nov 9 2026; all 9:00 AM with clock icons | Tue Nov 3, Wed Nov 4, Thu Nov 5, Fri Nov 6, Mon Nov 9 2026; all 9:00 AM with clock icons | match |
| Time controls | At; 9:00; AM selected; PM available | At; 9:00; AM selected; PM available | match |
| Cron preview | 0 9 * * 1-5; Edit cron link | 0 9 * * 1-5; Edit cron link | match |
| Resources section | Resources; Credentials and resources available to each run. | Resources; Credentials and resources available to each run. | match |
| Vault field | Credential vaults (optional); Manage credential vaults external link; Add vault (+) | Credential vaults (optional); Manage credential vaults external link; Add vault (+) | match |
| Session resources | Session resources (optional); Files, GitHub repositories, or memory stores mounted into each run’s session. | Session resources (optional); Files, GitHub repositories, or memory stores mounted into each run’s session. | match |
| Resource action | Add resource with dropdown arrow | Add resource with dropdown arrow | match |

## 05 — create-frequency-menu — PASS

| Element | Reference | OMA | Match / differs / missing |
| --- | --- | --- | --- |
| Page heading | Create deployment | Create deployment | match |
| Page description | Deploy an agent with a trigger, environment, and credentials. | Deploy an agent with a trigger, environment, and credentials. | match |
| Bottom actions | Cancel; Create deployment; stays available when scrolling | Cancel; Create deployment; stays available when scrolling | match |
| General section | General; What this deployment runs and where. | General; What this deployment runs and where. | match |
| Name | Name; Nightly inbox triage placeholder | Name; Nightly inbox triage placeholder | match |
| Agent field | Agent; Select an agent; Manage agents external link | Agent; Select an agent; Manage agents external link | match |
| Environment field | Environment; Select an environment; Manage environments external link | Environment; Select an environment; Manage environments external link | match |
| Initial message | Initial message; Summarize today’s support tickets and post to #digest | Initial message; Summarize today’s support tickets and post to #digest | match |
| Message help | Sent to the agent at the start of every run. (below textarea) | Sent to the agent at the start of every run. (below textarea) | match |
| Budget | Budget (optional); $ input; no limit when empty | Budget (optional); $ input; no limit when empty | match |
| Budget help | Stop the session once it reaches this cost, priced at public list rates. Leave empty for no limit. Agents may occasionally exceed the budget by at most one turn. | Stop the session once it reaches this cost, priced at public list rates. Leave empty for no limit. Agents may occasionally exceed the budget by at most one turn. | match |
| Trigger section | Trigger; Start runs on demand or on a schedule. | Trigger; Start runs on demand or on a schedule. | match |
| Trigger choices | Manual (hand); Schedule (calendar); Schedule selected | Manual (hand); Schedule (calendar); Schedule selected | match |
| Frequency and timezone | Frequency; Weekdays; Timezone; (GMT-06:00) America/Chicago | Frequency; Weekdays; Timezone; (GMT-06:00) America/Chicago | match |
| Next runs heading | Next 5 runs; information tooltip trigger | Next 5 runs; information tooltip trigger | match |
| Next run dates | Tue Nov 3, Wed Nov 4, Thu Nov 5, Fri Nov 6, Mon Nov 9 2026; all 9:00 AM with clock icons | Tue Nov 3, Wed Nov 4, Thu Nov 5, Fri Nov 6, Mon Nov 9 2026; all 9:00 AM with clock icons | match |
| Time controls | At; 9:00; AM selected; PM available | At; 9:00; AM selected; PM available | match |
| Cron preview | 0 9 * * 1-5; Edit cron link | 0 9 * * 1-5; Edit cron link | match |
| Frequency options in order | Every minute; Every hour; Daily; Weekdays (checked); Weekly; Custom cron | Every minute; Every hour; Daily; Weekdays (checked); Weekly; Custom cron | match |

## 06 — create-agent-empty — PASS

| Element | Reference | OMA | Match / differs / missing |
| --- | --- | --- | --- |
| Page heading | Create deployment | Create deployment | match |
| Page description | Deploy an agent with a trigger, environment, and credentials. | Deploy an agent with a trigger, environment, and credentials. | match |
| Bottom actions | Cancel; Create deployment; stays available when scrolling | Cancel; Create deployment; stays available when scrolling | match |
| General section | General; What this deployment runs and where. | General; What this deployment runs and where. | match |
| Name | Name; Nightly inbox triage placeholder | Name; Nightly inbox triage placeholder | match |
| Agent field | Agent; Select an agent; Manage agents external link | Agent; Select an agent; Manage agents external link | match |
| Environment field | Environment; Select an environment; Manage environments external link | Environment; Select an environment; Manage environments external link | match |
| Initial message | Initial message; Summarize today’s support tickets and post to #digest | Initial message; Summarize today’s support tickets and post to #digest | match |
| Message help | Sent to the agent at the start of every run. (below textarea) | Sent to the agent at the start of every run. (below textarea) | match |
| Budget | Budget (optional); $ input; no limit when empty | Budget (optional); $ input; no limit when empty | match |
| Budget help | Stop the session once it reaches this cost, priced at public list rates. Leave empty for no limit. Agents may occasionally exceed the budget by at most one turn. | Stop the session once it reaches this cost, priced at public list rates. Leave empty for no limit. Agents may occasionally exceed the budget by at most one turn. | match |
| Trigger section | Trigger; Start runs on demand or on a schedule. | Trigger; Start runs on demand or on a schedule. | match |
| Trigger choices | Manual (hand); Schedule (calendar); Schedule selected | Manual (hand); Schedule (calendar); Schedule selected | match |
| Frequency and timezone | Frequency; Weekdays; Timezone; (GMT-06:00) America/Chicago | Frequency; Weekdays; Timezone; (GMT-06:00) America/Chicago | match |
| Next runs heading | Next 5 runs; information tooltip trigger | Next 5 runs; information tooltip trigger | match |
| Next run dates | Tue Nov 3, Wed Nov 4, Thu Nov 5, Fri Nov 6, Mon Nov 9 2026; all 9:00 AM with clock icons | Tue Nov 3, Wed Nov 4, Thu Nov 5, Fri Nov 6, Mon Nov 9 2026; all 9:00 AM with clock icons | match |
| Time controls | At; 9:00; AM selected; PM available | At; 9:00; AM selected; PM available | match |
| Cron preview | 0 9 * * 1-5; Edit cron link | 0 9 * * 1-5; Edit cron link | match |
| Agent search | Search agents by name or exact ID | Search agents by name or exact ID | match |
| Agent empty result | No agents yet. | No agents yet. | match |

## 07 — create-environment-picker — PASS

| Element | Reference | OMA | Match / differs / missing |
| --- | --- | --- | --- |
| Page heading | Create deployment | Create deployment | match |
| Page description | Deploy an agent with a trigger, environment, and credentials. | Deploy an agent with a trigger, environment, and credentials. | match |
| Bottom actions | Cancel; Create deployment; stays available when scrolling | Cancel; Create deployment; stays available when scrolling | match |
| General section | General; What this deployment runs and where. | General; What this deployment runs and where. | match |
| Name | Name; Nightly inbox triage placeholder | Name; Nightly inbox triage placeholder | match |
| Agent field | Agent; Select an agent; Manage agents external link | Agent; Select an agent; Manage agents external link | match |
| Environment field | Environment; Select an environment; Manage environments external link | Environment; Select an environment; Manage environments external link | match |
| Initial message | Initial message; Summarize today’s support tickets and post to #digest | Initial message; Summarize today’s support tickets and post to #digest | match |
| Message help | Sent to the agent at the start of every run. (below textarea) | Sent to the agent at the start of every run. (below textarea) | match |
| Budget | Budget (optional); $ input; no limit when empty | Budget (optional); $ input; no limit when empty | match |
| Budget help | Stop the session once it reaches this cost, priced at public list rates. Leave empty for no limit. Agents may occasionally exceed the budget by at most one turn. | Stop the session once it reaches this cost, priced at public list rates. Leave empty for no limit. Agents may occasionally exceed the budget by at most one turn. | match |
| Trigger section | Trigger; Start runs on demand or on a schedule. | Trigger; Start runs on demand or on a schedule. | match |
| Trigger choices | Manual (hand); Schedule (calendar); Schedule selected | Manual (hand); Schedule (calendar); Schedule selected | match |
| Frequency and timezone | Frequency; Weekdays; Timezone; (GMT-06:00) America/Chicago | Frequency; Weekdays; Timezone; (GMT-06:00) America/Chicago | match |
| Next runs heading | Next 5 runs; information tooltip trigger | Next 5 runs; information tooltip trigger | match |
| Next run dates | Tue Nov 3, Wed Nov 4, Thu Nov 5, Fri Nov 6, Mon Nov 9 2026; all 9:00 AM with clock icons | Tue Nov 3, Wed Nov 4, Thu Nov 5, Fri Nov 6, Mon Nov 9 2026; all 9:00 AM with clock icons | match |
| Time controls | At; 9:00; AM selected; PM available | At; 9:00; AM selected; PM available | match |
| Cron preview | 0 9 * * 1-5; Edit cron link | 0 9 * * 1-5; Edit cron link | match |
| Environment search | Search environments by name or exact ID | Search environments by name or exact ID | match |
| Environment result | oma-lifecycle-probe; 5 days ago; Cloud; Organization | oma-lifecycle-probe; 5 days ago; Cloud; Organization | match |

## 08 — create-vault-empty — PASS

| Element | Reference | OMA | Match / differs / missing |
| --- | --- | --- | --- |
| Page heading | Create deployment | Create deployment | match |
| Page description | Deploy an agent with a trigger, environment, and credentials. | Deploy an agent with a trigger, environment, and credentials. | match |
| Bottom actions | Cancel; Create deployment; stays available when scrolling | Cancel; Create deployment; stays available when scrolling | match |
| Budget | Budget (optional); $ input; no limit when empty | Budget (optional); $ input; no limit when empty | match |
| Budget help | Stop the session once it reaches this cost, priced at public list rates. Leave empty for no limit. Agents may occasionally exceed the budget by at most one turn. | Stop the session once it reaches this cost, priced at public list rates. Leave empty for no limit. Agents may occasionally exceed the budget by at most one turn. | match |
| Trigger section | Trigger; Start runs on demand or on a schedule. | Trigger; Start runs on demand or on a schedule. | match |
| Trigger choices | Manual (hand); Schedule (calendar); Schedule selected | Manual (hand); Schedule (calendar); Schedule selected | match |
| Frequency and timezone | Frequency; Weekdays; Timezone; (GMT-06:00) America/Chicago | Frequency; Weekdays; Timezone; (GMT-06:00) America/Chicago | match |
| Next runs heading | Next 5 runs; information tooltip trigger | Next 5 runs; information tooltip trigger | match |
| Next run dates | Tue Nov 3, Wed Nov 4, Thu Nov 5, Fri Nov 6, Mon Nov 9 2026; all 9:00 AM with clock icons | Tue Nov 3, Wed Nov 4, Thu Nov 5, Fri Nov 6, Mon Nov 9 2026; all 9:00 AM with clock icons | match |
| Time controls | At; 9:00; AM selected; PM available | At; 9:00; AM selected; PM available | match |
| Cron preview | 0 9 * * 1-5; Edit cron link | 0 9 * * 1-5; Edit cron link | match |
| Resources section | Resources; Credentials and resources available to each run. | Resources; Credentials and resources available to each run. | match |
| Vault field | Credential vaults (optional); Manage credential vaults external link; Add vault (+) | Credential vaults (optional); Manage credential vaults external link; Add vault (+) | match |
| Session resources | Session resources (optional); Files, GitHub repositories, or memory stores mounted into each run’s session. | Session resources (optional); Files, GitHub repositories, or memory stores mounted into each run’s session. | match |
| Resource action | Add resource with dropdown arrow | Add resource with dropdown arrow | match |
| Vault search | Search vaults by name or exact ID | Search vaults by name or exact ID | match |
| Vault empty result | None in this workspace yet. | None in this workspace yet. | match |

## 09 — create-add-resource-menu — PASS

| Element | Reference | OMA | Match / differs / missing |
| --- | --- | --- | --- |
| Page heading | Create deployment | Create deployment | match |
| Page description | Deploy an agent with a trigger, environment, and credentials. | Deploy an agent with a trigger, environment, and credentials. | match |
| Bottom actions | Cancel; Create deployment; stays available when scrolling | Cancel; Create deployment; stays available when scrolling | match |
| Budget | Budget (optional); $ input; no limit when empty | Budget (optional); $ input; no limit when empty | match |
| Budget help | Stop the session once it reaches this cost, priced at public list rates. Leave empty for no limit. Agents may occasionally exceed the budget by at most one turn. | Stop the session once it reaches this cost, priced at public list rates. Leave empty for no limit. Agents may occasionally exceed the budget by at most one turn. | match |
| Trigger section | Trigger; Start runs on demand or on a schedule. | Trigger; Start runs on demand or on a schedule. | match |
| Trigger choices | Manual (hand); Schedule (calendar); Schedule selected | Manual (hand); Schedule (calendar); Schedule selected | match |
| Frequency and timezone | Frequency; Weekdays; Timezone; (GMT-06:00) America/Chicago | Frequency; Weekdays; Timezone; (GMT-06:00) America/Chicago | match |
| Next runs heading | Next 5 runs; information tooltip trigger | Next 5 runs; information tooltip trigger | match |
| Next run dates | Tue Nov 3, Wed Nov 4, Thu Nov 5, Fri Nov 6, Mon Nov 9 2026; all 9:00 AM with clock icons | Tue Nov 3, Wed Nov 4, Thu Nov 5, Fri Nov 6, Mon Nov 9 2026; all 9:00 AM with clock icons | match |
| Time controls | At; 9:00; AM selected; PM available | At; 9:00; AM selected; PM available | match |
| Cron preview | 0 9 * * 1-5; Edit cron link | 0 9 * * 1-5; Edit cron link | match |
| Resources section | Resources; Credentials and resources available to each run. | Resources; Credentials and resources available to each run. | match |
| Vault field | Credential vaults (optional); Manage credential vaults external link; Add vault (+) | Credential vaults (optional); Manage credential vaults external link; Add vault (+) | match |
| Session resources | Session resources (optional); Files, GitHub repositories, or memory stores mounted into each run’s session. | Session resources (optional); Files, GitHub repositories, or memory stores mounted into each run’s session. | match |
| Resource action | Add resource with dropdown arrow | Add resource with dropdown arrow | match |
| Resource menu in order | GitHub repository (branch icon); File (file icon); Memory store (database icon) | GitHub repository (branch icon); File (file icon); Memory store (database icon) | match |

## 10 — schedule-jitter-tooltip — FAIL (G1)

| Element | Reference | OMA | Match / differs / missing |
| --- | --- | --- | --- |
| Page heading | Create deployment | Create deployment | match |
| Page description | Deploy an agent with a trigger, environment, and credentials. | Deploy an agent with a trigger, environment, and credentials. | match |
| Bottom actions | Cancel; Create deployment; stays available when scrolling | Cancel; Create deployment; stays available when scrolling | match |
| Budget | Budget (optional); $ input; no limit when empty | Budget (optional); $ input; no limit when empty | match |
| Budget help | Stop the session once it reaches this cost, priced at public list rates. Leave empty for no limit. Agents may occasionally exceed the budget by at most one turn. | Stop the session once it reaches this cost, priced at public list rates. Leave empty for no limit. Agents may occasionally exceed the budget by at most one turn. | match |
| Trigger section | Trigger; Start runs on demand or on a schedule. | Trigger; Start runs on demand or on a schedule. | match |
| Trigger choices | Manual (hand); Schedule (calendar); Schedule selected | Manual (hand); Schedule (calendar); Schedule selected | match |
| Frequency and timezone | Frequency; Weekdays; Timezone; (GMT-06:00) America/Chicago | Frequency; Weekdays; Timezone; (GMT-06:00) America/Chicago | match |
| Next runs heading | Next 5 runs; information tooltip trigger | Next 5 runs; information tooltip trigger | match |
| Next run dates | Tue Nov 3, Wed Nov 4, Thu Nov 5, Fri Nov 6, Mon Nov 9 2026; all 9:00 AM with clock icons | Tue Nov 3, Wed Nov 4, Thu Nov 5, Fri Nov 6, Mon Nov 9 2026; all 9:00 AM with clock icons | match |
| Time controls | At; 9:00; AM selected; PM available | At; 9:00; AM selected; PM available | match |
| Cron preview | 0 9 * * 1-5; Edit cron link | 0 9 * * 1-5; Edit cron link | match |
| Resources section | Resources; Credentials and resources available to each run. | Resources; Credentials and resources available to each run. | match |
| Vault field | Credential vaults (optional); Manage credential vaults external link; Add vault (+) | Credential vaults (optional); Manage credential vaults external link; Add vault (+) | match |
| Session resources | Session resources (optional); Files, GitHub repositories, or memory stores mounted into each run’s session. | Session resources (optional); Files, GitHub repositories, or memory stores mounted into each run’s session. | match |
| Resource action | Add resource with dropdown arrow | Add resource with dropdown arrow | match |
| Tooltip text | Runs start within a short window after the scheduled time to spread load — up to ~9 seconds for minute-level schedules, up to ~9 minutes for hourly and longer intervals. Times shown are targets, not exact start times. | Times shown are targets, not exact start times. | differs — backend has no bounded-jitter contract (G1) |

## 11 — create-custom-cron — PASS

| Element | Reference | OMA | Match / differs / missing |
| --- | --- | --- | --- |
| Page heading | Create deployment | Create deployment | match |
| Page description | Deploy an agent with a trigger, environment, and credentials. | Deploy an agent with a trigger, environment, and credentials. | match |
| Bottom actions | Cancel; Create deployment; stays available when scrolling | Cancel; Create deployment; stays available when scrolling | match |
| Budget | Budget (optional); $ input; no limit when empty | Budget (optional); $ input; no limit when empty | match |
| Budget help | Stop the session once it reaches this cost, priced at public list rates. Leave empty for no limit. Agents may occasionally exceed the budget by at most one turn. | Stop the session once it reaches this cost, priced at public list rates. Leave empty for no limit. Agents may occasionally exceed the budget by at most one turn. | match |
| Trigger section | Trigger; Start runs on demand or on a schedule. | Trigger; Start runs on demand or on a schedule. | match |
| Trigger choices | Manual (hand); Schedule (calendar); Schedule selected | Manual (hand); Schedule (calendar); Schedule selected | match |
| Frequency and timezone | Frequency; Custom cron; Timezone; (GMT-06:00) America/Chicago | Frequency; Custom cron; Timezone; (GMT-06:00) America/Chicago | match |
| Next runs heading | Next 5 runs; information tooltip trigger | Next 5 runs; information tooltip trigger | match |
| Next run dates | Tue Nov 3, Wed Nov 4, Thu Nov 5, Fri Nov 6, Mon Nov 9 2026; all 9:00 AM with clock icons | Tue Nov 3, Wed Nov 4, Thu Nov 5, Fri Nov 6, Mon Nov 9 2026; all 9:00 AM with clock icons | match |
| Cron editor | Cron expression; editable 0 9 * * 1-5 | Cron expression; editable 0 9 * * 1-5 | match |
| Cron help | minute hour day month weekday — * any, */5 every 5th, 1–5 range | minute hour day month weekday — * any, */5 every 5th, 1–5 range | match |
| Resources section | Resources; Credentials and resources available to each run. | Resources; Credentials and resources available to each run. | match |
| Vault field | Credential vaults (optional); Manage credential vaults external link; Add vault (+) | Credential vaults (optional); Manage credential vaults external link; Add vault (+) | match |
| Session resources | Session resources (optional); Files, GitHub repositories, or memory stores mounted into each run’s session. | Session resources (optional); Files, GitHub repositories, or memory stores mounted into each run’s session. | match |
| Resource action | Add resource with dropdown arrow | Add resource with dropdown arrow | match |

## 12 — resource-github — PASS

| Element | Reference | OMA | Match / differs / missing |
| --- | --- | --- | --- |
| Page heading | Create deployment | Create deployment | match |
| Page description | Deploy an agent with a trigger, environment, and credentials. | Deploy an agent with a trigger, environment, and credentials. | match |
| Bottom actions | Cancel; Create deployment; stays available when scrolling | Cancel; Create deployment; stays available when scrolling | match |
| Frequency and timezone | Frequency; Custom cron; Timezone; (GMT-06:00) America/Chicago | Frequency; Custom cron; Timezone; (GMT-06:00) America/Chicago | match |
| Next runs heading | Next 5 runs; information tooltip trigger | Next 5 runs; information tooltip trigger | match |
| Next run dates | Tue Nov 3, Wed Nov 4, Thu Nov 5, Fri Nov 6, Mon Nov 9 2026; all 9:00 AM with clock icons | Tue Nov 3, Wed Nov 4, Thu Nov 5, Fri Nov 6, Mon Nov 9 2026; all 9:00 AM with clock icons | match |
| Cron editor | Cron expression; editable 0 9 * * 1-5 | Cron expression; editable 0 9 * * 1-5 | match |
| Cron help | minute hour day month weekday — * any, */5 every 5th, 1–5 range | minute hour day month weekday — * any, */5 every 5th, 1–5 range | match |
| Resources section | Resources; Credentials and resources available to each run. | Resources; Credentials and resources available to each run. | match |
| Vault field | Credential vaults (optional); Manage credential vaults external link; Add vault (+) | Credential vaults (optional); Manage credential vaults external link; Add vault (+) | match |
| Session resources | Session resources (optional); Files, GitHub repositories, or memory stores mounted into each run’s session. | Session resources (optional); Files, GitHub repositories, or memory stores mounted into each run’s session. | match |
| Resource action | Add resource with dropdown arrow | Add resource with dropdown arrow | match |
| Repository card | GitHub repository; remove/trash action | GitHub repository; remove/trash action | match |
| Repository URL | URL; https://github.com/owner/repo placeholder | URL; https://github.com/owner/repo placeholder | match |
| Repository credentials | Authorization token; ghp_… placeholder; masked input | Authorization token; ghp_… placeholder; masked input | match |
| Checkout | Checkout (optional); None | Checkout (optional); None | match |
| Mount path | Mount path (optional); /workspace/repo-name (default) | Mount path (optional); /workspace/repo-name (default) | match |

## 13 — resource-file-upload — PASS

| Element | Reference | OMA | Match / differs / missing |
| --- | --- | --- | --- |
| Page heading | Create deployment | Create deployment | match |
| Page description | Deploy an agent with a trigger, environment, and credentials. | Deploy an agent with a trigger, environment, and credentials. | match |
| Bottom actions | Cancel; Create deployment; stays available when scrolling | Cancel; Create deployment; stays available when scrolling | match |
| Trigger section | Trigger; Start runs on demand or on a schedule. | Trigger; Start runs on demand or on a schedule. | match |
| Trigger choices | Manual (hand); Schedule (calendar); Schedule selected | Manual (hand); Schedule (calendar); Schedule selected | match |
| Frequency and timezone | Frequency; Custom cron; Timezone; (GMT-06:00) America/Chicago | Frequency; Custom cron; Timezone; (GMT-06:00) America/Chicago | match |
| Next runs heading | Next 5 runs; information tooltip trigger | Next 5 runs; information tooltip trigger | match |
| Next run dates | Tue Nov 3, Wed Nov 4, Thu Nov 5, Fri Nov 6, Mon Nov 9 2026; all 9:00 AM with clock icons | Tue Nov 3, Wed Nov 4, Thu Nov 5, Fri Nov 6, Mon Nov 9 2026; all 9:00 AM with clock icons | match |
| Cron editor | Cron expression; editable 0 9 * * 1-5 | Cron expression; editable 0 9 * * 1-5 | match |
| Cron help | minute hour day month weekday — * any, */5 every 5th, 1–5 range | minute hour day month weekday — * any, */5 every 5th, 1–5 range | match |
| Resources section | Resources; Credentials and resources available to each run. | Resources; Credentials and resources available to each run. | match |
| Vault field | Credential vaults (optional); Manage credential vaults external link; Add vault (+) | Credential vaults (optional); Manage credential vaults external link; Add vault (+) | match |
| Session resources | Session resources (optional); Files, GitHub repositories, or memory stores mounted into each run’s session. | Session resources (optional); Files, GitHub repositories, or memory stores mounted into each run’s session. | match |
| Resource action | Add resource with dropdown arrow | Add resource with dropdown arrow | match |
| File card | File; remove/trash action | File; remove/trash action | match |
| File modes | Upload (selected); File ID | Upload (selected); File ID | match |
| Drop target | Drop a file here; Choose a file button; drag/drop supported | Drop a file here; Choose a file button; drag/drop supported | match |
| File mount input | /uploads/myfile.txt placeholder | /uploads/myfile.txt placeholder | match |
| Upload API flow | Selecting a file uploads it and preserves its ID for the deployment | POST /v1/files multipart file; returned file_id in deployment resources | match (Chromium checks filename/content and ID) |

## 14 — resource-memory — PASS

| Element | Reference | OMA | Match / differs / missing |
| --- | --- | --- | --- |
| Page heading | Create deployment | Create deployment | match |
| Page description | Deploy an agent with a trigger, environment, and credentials. | Deploy an agent with a trigger, environment, and credentials. | match |
| Bottom actions | Cancel; Create deployment; stays available when scrolling | Cancel; Create deployment; stays available when scrolling | match |
| Trigger section | Trigger; Start runs on demand or on a schedule. | Trigger; Start runs on demand or on a schedule. | match |
| Trigger choices | Manual (hand); Schedule (calendar); Schedule selected | Manual (hand); Schedule (calendar); Schedule selected | match |
| Frequency and timezone | Frequency; Custom cron; Timezone; (GMT-06:00) America/Chicago | Frequency; Custom cron; Timezone; (GMT-06:00) America/Chicago | match |
| Next runs heading | Next 5 runs; information tooltip trigger | Next 5 runs; information tooltip trigger | match |
| Next run dates | Tue Nov 3, Wed Nov 4, Thu Nov 5, Fri Nov 6, Mon Nov 9 2026; all 9:00 AM with clock icons | Tue Nov 3, Wed Nov 4, Thu Nov 5, Fri Nov 6, Mon Nov 9 2026; all 9:00 AM with clock icons | match |
| Cron editor | Cron expression; editable 0 9 * * 1-5 | Cron expression; editable 0 9 * * 1-5 | match |
| Cron help | minute hour day month weekday — * any, */5 every 5th, 1–5 range | minute hour day month weekday — * any, */5 every 5th, 1–5 range | match |
| Resources section | Resources; Credentials and resources available to each run. | Resources; Credentials and resources available to each run. | match |
| Vault field | Credential vaults (optional); Manage credential vaults external link; Add vault (+) | Credential vaults (optional); Manage credential vaults external link; Add vault (+) | match |
| Session resources | Session resources (optional); Files, GitHub repositories, or memory stores mounted into each run’s session. | Session resources (optional); Files, GitHub repositories, or memory stores mounted into each run’s session. | match |
| Resource action | Add resource with dropdown arrow | Add resource with dropdown arrow | match |
| Memory card header | Memory store; Manage memory stores external link; remove/trash action | Memory store; Manage memory stores external link; remove/trash action | match |
| Memory selector | Select a memory store | Select a memory store | match |
| Memory access | Access; Read & write selected | Access; Read & write selected | match |
| Memory instructions | Instructions (optional); Tell the agent what this store contains and when to use it. | Instructions (optional); Tell the agent what this store contains and when to use it. | match |

## 15 — github-checkout-options — PASS

| Element | Reference | OMA | Match / differs / missing |
| --- | --- | --- | --- |
| Page heading | Create deployment | Create deployment | match |
| Page description | Deploy an agent with a trigger, environment, and credentials. | Deploy an agent with a trigger, environment, and credentials. | match |
| Bottom actions | Cancel; Create deployment; stays available when scrolling | Cancel; Create deployment; stays available when scrolling | match |
| Frequency and timezone | Frequency; Custom cron; Timezone; (GMT-06:00) America/Chicago | Frequency; Custom cron; Timezone; (GMT-06:00) America/Chicago | match |
| Next runs heading | Next 5 runs; information tooltip trigger | Next 5 runs; information tooltip trigger | match |
| Next run dates | Tue Nov 3, Wed Nov 4, Thu Nov 5, Fri Nov 6, Mon Nov 9 2026; all 9:00 AM with clock icons | Tue Nov 3, Wed Nov 4, Thu Nov 5, Fri Nov 6, Mon Nov 9 2026; all 9:00 AM with clock icons | match |
| Cron editor | Cron expression; editable 0 9 * * 1-5 | Cron expression; editable 0 9 * * 1-5 | match |
| Cron help | minute hour day month weekday — * any, */5 every 5th, 1–5 range | minute hour day month weekday — * any, */5 every 5th, 1–5 range | match |
| Resources section | Resources; Credentials and resources available to each run. | Resources; Credentials and resources available to each run. | match |
| Vault field | Credential vaults (optional); Manage credential vaults external link; Add vault (+) | Credential vaults (optional); Manage credential vaults external link; Add vault (+) | match |
| Session resources | Session resources (optional); Files, GitHub repositories, or memory stores mounted into each run’s session. | Session resources (optional); Files, GitHub repositories, or memory stores mounted into each run’s session. | match |
| Resource action | Add resource with dropdown arrow | Add resource with dropdown arrow | match |
| Repository card | GitHub repository; remove/trash action | GitHub repository; remove/trash action | match |
| Repository URL | URL; https://github.com/owner/repo placeholder | URL; https://github.com/owner/repo placeholder | match |
| Repository credentials | Authorization token; ghp_… placeholder; masked input | Authorization token; ghp_… placeholder; masked input | match |
| Checkout | Checkout (optional); None | Checkout (optional); None | match |
| Mount path | Mount path (optional); /workspace/repo-name (default) | Mount path (optional); /workspace/repo-name (default) | match |
| Checkout options | None (checked); Branch; Commit | None (checked); Branch; Commit | match |

## 16 — github-branch-fields — PASS

| Element | Reference | OMA | Match / differs / missing |
| --- | --- | --- | --- |
| Page heading | Create deployment | Create deployment | match |
| Page description | Deploy an agent with a trigger, environment, and credentials. | Deploy an agent with a trigger, environment, and credentials. | match |
| Bottom actions | Cancel; Create deployment; stays available when scrolling | Cancel; Create deployment; stays available when scrolling | match |
| Frequency and timezone | Frequency; Custom cron; Timezone; (GMT-06:00) America/Chicago | Frequency; Custom cron; Timezone; (GMT-06:00) America/Chicago | match |
| Next runs heading | Next 5 runs; information tooltip trigger | Next 5 runs; information tooltip trigger | match |
| Next run dates | Tue Nov 3, Wed Nov 4, Thu Nov 5, Fri Nov 6, Mon Nov 9 2026; all 9:00 AM with clock icons | Tue Nov 3, Wed Nov 4, Thu Nov 5, Fri Nov 6, Mon Nov 9 2026; all 9:00 AM with clock icons | match |
| Cron editor | Cron expression; editable 0 9 * * 1-5 | Cron expression; editable 0 9 * * 1-5 | match |
| Cron help | minute hour day month weekday — * any, */5 every 5th, 1–5 range | minute hour day month weekday — * any, */5 every 5th, 1–5 range | match |
| Resources section | Resources; Credentials and resources available to each run. | Resources; Credentials and resources available to each run. | match |
| Vault field | Credential vaults (optional); Manage credential vaults external link; Add vault (+) | Credential vaults (optional); Manage credential vaults external link; Add vault (+) | match |
| Session resources | Session resources (optional); Files, GitHub repositories, or memory stores mounted into each run’s session. | Session resources (optional); Files, GitHub repositories, or memory stores mounted into each run’s session. | match |
| Resource action | Add resource with dropdown arrow | Add resource with dropdown arrow | match |
| Repository card | GitHub repository; remove/trash action | GitHub repository; remove/trash action | match |
| Repository URL | URL; https://github.com/owner/repo placeholder | URL; https://github.com/owner/repo placeholder | match |
| Repository credentials | Authorization token; ghp_… placeholder; masked input | Authorization token; ghp_… placeholder; masked input | match |
| Checkout | Checkout (optional); Branch | Checkout (optional); Branch | match |
| Mount path | Mount path (optional); /workspace/repo-name (default) | Mount path (optional); /workspace/repo-name (default) | match |
| Branch-specific field | Name; main placeholder | Name; main placeholder | match |

## 17 — unsaved-changes-dialog — PASS

| Element | Reference | OMA | Match / differs / missing |
| --- | --- | --- | --- |
| Page heading | Create deployment | Create deployment | match |
| Page description | Deploy an agent with a trigger, environment, and credentials. | Deploy an agent with a trigger, environment, and credentials. | match |
| Bottom actions | Cancel; Create deployment; stays available when scrolling | Cancel; Create deployment; stays available when scrolling | match |
| Frequency and timezone | Frequency; Custom cron; Timezone; (GMT-06:00) America/Chicago | Frequency; Custom cron; Timezone; (GMT-06:00) America/Chicago | match |
| Next runs heading | Next 5 runs; information tooltip trigger | Next 5 runs; information tooltip trigger | match |
| Next run dates | Tue Nov 3, Wed Nov 4, Thu Nov 5, Fri Nov 6, Mon Nov 9 2026; all 9:00 AM with clock icons | Tue Nov 3, Wed Nov 4, Thu Nov 5, Fri Nov 6, Mon Nov 9 2026; all 9:00 AM with clock icons | match |
| Cron editor | Cron expression; editable 0 9 * * 1-5 | Cron expression; editable 0 9 * * 1-5 | match |
| Cron help | minute hour day month weekday — * any, */5 every 5th, 1–5 range | minute hour day month weekday — * any, */5 every 5th, 1–5 range | match |
| Resources section | Resources; Credentials and resources available to each run. | Resources; Credentials and resources available to each run. | match |
| Vault field | Credential vaults (optional); Manage credential vaults external link; Add vault (+) | Credential vaults (optional); Manage credential vaults external link; Add vault (+) | match |
| Session resources | Session resources (optional); Files, GitHub repositories, or memory stores mounted into each run’s session. | Session resources (optional); Files, GitHub repositories, or memory stores mounted into each run’s session. | match |
| Resource action | Add resource with dropdown arrow | Add resource with dropdown arrow | match |
| Repository card | GitHub repository; remove/trash action | GitHub repository; remove/trash action | match |
| Repository URL | URL; https://github.com/owner/repo placeholder | URL; https://github.com/owner/repo placeholder | match |
| Repository credentials | Authorization token; ghp_… placeholder; masked input | Authorization token; ghp_… placeholder; masked input | match |
| Checkout | Checkout (optional); Commit | Checkout (optional); Commit | match |
| Mount path | Mount path (optional); /workspace/repo-name (default) | Mount path (optional); /workspace/repo-name (default) | match |
| Commit-specific field behind dialog | Commit SHA; abc123... placeholder | Commit SHA; abc123... placeholder | match |
| Unsaved dialog title | Unsaved changes | Unsaved changes | match |
| Unsaved dialog message | If you leave this page, your changes will be lost. | If you leave this page, your changes will be lost. | match |
| Unsaved dialog actions | Stay (keep draft); Leave (discard draft and navigate) | Stay (keep draft); Leave (discard draft and navigate) | match |
| Unsaved dialog behavior | Blocks Cancel/navigation after edits; dimmed backdrop; focus trapped | Blocks Cancel/navigation after edits; dimmed backdrop; focus trapped | match |

## 18 — memory-access — PASS

| Element | Reference | OMA | Match / differs / missing |
| --- | --- | --- | --- |
| Page heading | Create deployment | Create deployment | match |
| Page description | Deploy an agent with a trigger, environment, and credentials. | Deploy an agent with a trigger, environment, and credentials. | match |
| Bottom actions | Cancel; Create deployment; stays available when scrolling | Cancel; Create deployment; stays available when scrolling | match |
| Trigger section | Trigger; Start runs on demand or on a schedule. | Trigger; Start runs on demand or on a schedule. | match |
| Trigger choices | Manual (hand); Schedule (calendar); Schedule selected | Manual (hand); Schedule (calendar); Schedule selected | match |
| Frequency and timezone | Frequency; Custom cron; Timezone; (GMT-06:00) America/Chicago | Frequency; Custom cron; Timezone; (GMT-06:00) America/Chicago | match |
| Next runs heading | Next 5 runs; information tooltip trigger | Next 5 runs; information tooltip trigger | match |
| Next run dates | Tue Nov 3, Wed Nov 4, Thu Nov 5, Fri Nov 6, Mon Nov 9 2026; all 9:00 AM with clock icons | Tue Nov 3, Wed Nov 4, Thu Nov 5, Fri Nov 6, Mon Nov 9 2026; all 9:00 AM with clock icons | match |
| Cron editor | Cron expression; editable 0 9 * * 1-5 | Cron expression; editable 0 9 * * 1-5 | match |
| Cron help | minute hour day month weekday — * any, */5 every 5th, 1–5 range | minute hour day month weekday — * any, */5 every 5th, 1–5 range | match |
| Resources section | Resources; Credentials and resources available to each run. | Resources; Credentials and resources available to each run. | match |
| Vault field | Credential vaults (optional); Manage credential vaults external link; Add vault (+) | Credential vaults (optional); Manage credential vaults external link; Add vault (+) | match |
| Session resources | Session resources (optional); Files, GitHub repositories, or memory stores mounted into each run’s session. | Session resources (optional); Files, GitHub repositories, or memory stores mounted into each run’s session. | match |
| Resource action | Add resource with dropdown arrow | Add resource with dropdown arrow | match |
| Memory card header | Memory store; Manage memory stores external link; remove/trash action | Memory store; Manage memory stores external link; remove/trash action | match |
| Memory selector | Select a memory store | Select a memory store | match |
| Memory access | Access; Read & write selected | Access; Read & write selected | match |
| Memory instructions | Instructions (optional); Tell the agent what this store contains and when to use it. | Instructions (optional); Tell the agent what this store contains and when to use it. | match |
| Access menu options | Read & write (checked); Read only | Read & write (checked); Read only | match |

## 19 — sessions-list-skeleton — PASS

| Element | Reference | OMA | Match / differs / missing |
| --- | --- | --- | --- |
| Heading/action | Sessions; Create session | Sessions; Create session | match |
| Description | Trace and debug Claude Managed Agents sessions. | Trace and debug Open Managed Agents sessions. | match (product name adapted to OMA) |
| Search | Find session by ID | Find session by ID | match |
| Filters in order | Created by: Anyone; Created: All time; Agent: All; Deployment: All; Status: Active | Created by: Anyone; Created: All time; Agent: All; Deployment: All; Status: Active | match |
| Column sequence | Selection checkbox; ID; Name; Status; Agent; Cost (info tooltip); Tokens in / out; Created by; Created; row actions | Selection checkbox; ID; Name; Status; Agent; Cost (info tooltip); Tokens in / out; Created by; Created; row actions | match |
| Loading state | 10 rows, placeholders in each column; empty state hidden | 10 rows, placeholders in each column; empty state hidden | match |

## 20 — sessions-empty — PASS

| Element | Reference | OMA | Match / differs / missing |
| --- | --- | --- | --- |
| Heading/action | Sessions; Create session | Sessions; Create session | match |
| Description | Trace and debug Claude Managed Agents sessions. | Trace and debug Open Managed Agents sessions. | match (product name adapted to OMA) |
| Search | Find session by ID | Find session by ID | match |
| Filters in order | Created by: Anyone; Created: All time; Agent: All; Deployment: All; Status: Active | Created by: Anyone; Created: All time; Agent: All; Deployment: All; Status: Active | match |
| Empty title | No active sessions | No active sessions | match |
| Empty body | New sessions will appear here. Archived and terminated sessions are hidden from this view. | New sessions will appear here. Archived and terminated sessions are hidden from this view. | match |
| Empty action | Show all sessions; removes active-only filtering and includes archived sessions | Show all sessions; removes active-only filtering and includes archived sessions | match |
| Empty illustration | Two conversation bubbles | OMA conversation bubbles | match (OMA icon styling) |

## 21 — sessions-deployment-filter — PASS

| Element | Reference | OMA | Match / differs / missing |
| --- | --- | --- | --- |
| Heading/action | Sessions; Create session | Sessions; Create session | match |
| Description | Trace and debug Claude Managed Agents sessions. | Trace and debug Open Managed Agents sessions. | match (product name adapted to OMA) |
| Search | Find session by ID | Find session by ID | match |
| Filters in order | Created by: Anyone; Created: All time; Agent: All; Deployment: All; Status: Active | Created by: Anyone; Created: All time; Agent: All; Deployment: All; Status: Active | match |
| Empty title | No active sessions | No active sessions | match |
| Empty body | New sessions will appear here. Archived and terminated sessions are hidden from this view. | New sessions will appear here. Archived and terminated sessions are hidden from this view. | match |
| Empty action | Show all sessions; removes active-only filtering and includes archived sessions | Show all sessions; removes active-only filtering and includes archived sessions | match |
| Empty illustration | Two conversation bubbles | OMA conversation bubbles | match (OMA icon styling) |
| Deployment picker search | Search by name or exact ID | Search by name or exact ID | match |
| Deployment picker empty copy | No deployments yet. | No deployments yet. | match |
| Deployment filter API | Pick deployment by name/exact ID | GET /v1/sessions?deployment_id=… (tested) | match |

## 22 — environments-list — PASS

| Element | Reference | OMA | Match / differs / missing |
| --- | --- | --- | --- |
| Heading/action | Environments; Create environment | Environments; Create environment | match |
| Description | Configuration template for containers, such as sessions or code execution. | Configuration template for containers, such as sessions or code execution. | match |
| Search | Search by name or exact ID | Search by name or exact ID | match |
| Filter | Status: Active | Status: Active | match |
| Column sequence | Selection checkbox; ID; Name; Type; Scope; Updated at; Archived at; row actions | Selection checkbox; ID; Name; Type; Scope; Updated at; Archived at; row actions | match |
| Fixture row | env_015G274T4yMp3tsjGAWJfQ7V; oma-lifecycle-probe; Cloud; Organization; Oct 29; blank archived date; ellipsis menu | env_015G274T4yMp3tsjGAWJfQ7V; oma-lifecycle-probe; Cloud; Organization; Oct 29; blank archived date; ellipsis menu | match |

## Verification results

- Console typecheck: PASS.
- Console tests: PASS, 85 files / 434 tests.
- Console production build: PASS (existing large-chunk advisory).
- Oxlint with `--deny-warnings` on changed files: PASS.
- Capture script: PASS, 22 PNGs + 22 composites, Chromium multipart checks passed.
- `git diff --check`: PASS.

## Reproduce and verify

```sh
export COREPACK_HOME=$HOME/.corepack
pnpm --filter managed-agents-console dev --host 127.0.0.1
# In another shell, with the same COREPACK_HOME:
node apps/console/scripts/capture-448-acceptance.mjs
pnpm --filter managed-agents-console typecheck
pnpm --filter managed-agents-console test
pnpm --filter managed-agents-console build
pnpm dlx oxlint --deny-warnings <changed source files> apps/console/scripts/capture-448-acceptance.mjs
```

The capture script intercepts every `/v1/` and auth request, holds list requests pending for skeleton states, blocks external requests (including remote font stylesheets), checks each unique state, verifies real Chromium multipart upload filename/content and returned file ID after capturing state 13, and writes all 22 composites using Pillow. It refuses a nonlocal BASE_URL. No production API calls, resources, or credentials are used.

Regression tests cover exact empty picker copy/search, multipart upload and retry, File ID plus read-only memory payloads, schedule presets/custom cron/invalid times/timezone previews, unsaved navigation, session deployment query, active/all empty flow, complete skeleton columns, environment scope/date columns, list actions, and bilingual deployment rendering. All added UI text is in en + zh-CN dictionaries.
