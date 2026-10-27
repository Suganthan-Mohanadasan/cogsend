# Scheduling

Scheduled posts live in D1 and are considered for publishing by a _tick_: either the Worker's own cron trigger or an authenticated caller of the tick endpoint. Every delivery requires approval of its exact payload, destination and scheduled time, and publishing must be enabled.

## Approvals and halted publishing

At `/approvals`, select a draft, destination and exact time, then choose **Review final payload** and **Approve this exact payload**. **Schedule approved post** is a separate action. Repeat for each destination. Changing the draft, variant, media, destination or time requires fresh approval; editing and reverting the content still invalidates the old approval. Existing scheduled posts are not approved automatically during an upgrade.

Keep both `PUBLISHING_HALTED=1` and `app_settings.publishing_halted=true` enabled while validating a deployment. Disable cron triggers, external tick pingers and queue consumers as well, so validation does not process or change waiting deliveries. The old, ungated Worker does not understand either halt setting: pause its writers and scheduler sources before taking the frozen backup and migrating.

After a separate decision to resume, review the exact payloads and times, approve each destination, and restore the intended scheduler source while both halt controls remain on. Set the environment override to `0` and deploy the reviewed configuration, verify the database halt still reports true, then deliberately release the database halt in `/approvals`. Any approved overdue delivery may become eligible immediately. Never release a halt as a way to test it.

A missing or stale approval blocks delivery with `needs_reapproval`. A dispatch that has already begun remains locked after a crash, timeout, partial thread or video-processing pause; it cannot be automatically retried. Migration quarantines legacy attempted deliveries as `legacy_reconciliation_required`. Reconcile their provider outcome before considering replacement content; do not clear the dispatch ledger. See [Publishing behaviour](api.md#publishing-behaviour).

## How a tick works

- The cron trigger ships enabled in `wrangler.jsonc` (`"triggers"`) and runs every minute.
- A tick considers the oldest due post first and starts further deliveries only while its estimated calls fit the request's Cloudflare budget. Each delivery still passes the approval, halt, duplicate and dispatch checks. Anything that does not fit stays due for a later tick. `SUBREQUEST_LIMIT` in [Configuration](configuration.md#secrets) sets that budget for the instance's plan.
- Ticks are idempotent: a duplicated or delayed caller is harmless.
- A tick that runs out of the plan's CPU budget also leaves the rest due for the next minute.

The trigger is registered the moment the Worker is deployed, but the first tick
can take a few minutes — Cloudflare runs a Worker's cron on machines that have
spare capacity. Until one arrives, **Settings → Scheduled publishing** says "no
tick yet"; that is the normal state for the first few minutes of a fresh install,
not a failure. If it still says that an hour later,
`npm run doctor -- --app-url <url>` says which of the cases you are in: ticks
arriving, no trigger configured, or a refused trigger. A heartbeat older than six
hours counts as delayed, and the app says so wherever the scheduler is shown.

## Pick one tick

The built-in cron needs nothing from you, but the Workers free plan allows only
**five cron triggers per account** — shared with every other Worker you run. If
your account has none left, `npm run deploy` says so, retries without the trigger,
and still ships the app; scheduled posts then wait until something calls the tick
endpoint.

**Settings → Scheduled publishing** covers both paths: it shows whether ticks are
arriving, and can generate a token for an external cron (cron-job.org,
UptimeRobot, the bundled GitHub Actions workflow). Keep one primary tick — there
is no reason to run a per-minute pinger alongside the cron.

To drive the tick from something else — cron-job.org, a Raspberry Pi, a systemd
timer, the bundled GitHub Actions workflow, a different cadence on a paid plan —
POST to it:

```sh
curl -X POST "$APP_URL/api/internal/tick" \
  -H "Authorization: Bearer $SCHEDULER_SECRET" \
  -H "Content-Type: application/json"
```

The endpoint takes `SCHEDULER_SECRET` (`API_TOKEN` still works as a fallback; `AUTH_SECRET` never does — it signs sessions and is rejected on the wire). Any `Content-Type`, or none, is fine: the cross-site check refuses a body-less or form-type POST only when it carries no credential of its own, and a tick always carries its bearer token.

An external caller needs a bearer it can read. Easiest is the token from
**Settings → Scheduled publishing**, which needs no redeploy and cannot reach
anything except the tick. The alternative is `SCHEDULER_SECRET`
(`openssl rand -hex 32`), which then lives in two places — the Worker secret and
the pinger's config — so rotate both together. Without one of those (or
`API_TOKEN`) an external caller cannot authenticate at all; the built-in cron
keeps working either way, because the Worker derives the same value.

The bundled GitHub workflow (`.github/workflows/scheduler-tick.yml`) stays off
until you set repository secrets `APP_URL` and `SCHEDULER_SECRET` — the token
from **Settings → Scheduled publishing** works as that `SCHEDULER_SECRET` value. With the
built-in cron running, treat it as a backup rather than the primary tick: it is
scheduled every five minutes (GitHub's shortest interval) but GitHub throttles it
to roughly one run every two hours. You can also run it by hand from
**Actions → Scheduler tick → Run workflow**.

## Cadence

Edit `triggers.crons` in `wrangler.jsonc` — `*/5 * * * *` and friends are fine on
the free plan too. To use no trigger at all, set `"crons": []` and point a pinger
at the endpoint instead; `npm run doctor -- --app-url <url>` confirms which of the
two is actually running.

## Failure alerts (optional)

The dashboard shows a "failed to publish" banner linking to the Failed tab. To
also get a morning-after email, set `RESEND_API_KEY` and `NOTIFY_EMAIL` as Worker
secrets (the app no-ops without them), plus an optional `NOTIFY_FROM` sender on a
domain verified in Resend. At most one digest is sent per 24h window, covering
failures newer than the last digest. Posts that are still retrying are not
emailed.
