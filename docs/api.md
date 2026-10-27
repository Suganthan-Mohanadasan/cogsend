# API

The browser UI uses the `cog_session` cookie after TOTP. Scripts, Shortcuts and [MCP clients](#mcp-server) use scoped personal API keys. Manage independent keys in `/approvals`; creating one does not revoke the others. The raw key is shown once and only its hash is stored. The in-app `/api` reference describes request formats; the approval requirements below apply to every publishing route.

## Authentication

Export your instance URL and the appropriate key:

```sh
export APP_URL=https://cogsend.<account>.workers.dev
export COGSEND_API_KEY=cog_...

curl -s "$APP_URL/api/connections" -H "Authorization: Bearer $COGSEND_API_KEY"
```

`X-API-Key` works as an alternative header; never put a key in the URL. Use separate keys for drafting and approval:

| Scope              | Authority                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| `read`             | Read state and preview approval payloads; cannot change content or approve delivery.                            |
| `draft`            | Read, create and edit drafts, variants and media; cannot approve, schedule, publish or retry.                   |
| `approve_schedule` | Read and approve exact payloads, then schedule, publish or retry through the approval gate; cannot edit drafts. |

No API key can manage keys, change the publishing halt, or connect, re-verify or disconnect accounts. Those actions require a verified browser session. Session-only `GET /api/key` lists keys; `POST /api/key` creates a key with `scopes`, and `DELETE /api/key?id=KEY_ID` revokes just that key. Omitting `id` revokes all keys.

Legacy `write` keys have draft authority only. Missing legacy scopes default to `draft`; malformed scopes fail closed. The global `API_TOKEN` has draft-only access on ordinary API routes and is rejected by MCP. Its existing internal scheduler role can process already approved due deliveries, but cannot approve content or bypass publishing checks.

## Approval workflow

Approval is specific to one destination and the exact UTC scheduled time, or `null` for manual publishing. `GET /api/drafts/:id/approval?connectionId=CONN_ID&scheduledFor=ISO_TIME` returns the canonical payload and its SHA-256 hash. Omit `scheduledFor` for manual publishing. Review the returned platform, account identity, text/thread/options, media and time before submitting the hash.

`POST /api/drafts/:id/approval` requires `connectionId`, the reviewed `hash` and the same `scheduledFor`. A stale or incorrect hash returns 409. The server records the authenticated user or API-key ID, review channel, revision, hashes and time. Approval does not itself publish or schedule anything.

Draft, variant and media edits invalidate approval, including edits that are later reverted. Destination or time changes also require fresh approval. The publisher rehashes before dispatch and checks again before each outbound platform request. A mismatch blocks delivery with `needs_reapproval`. Use `/approvals` for the browser workflow and recent audit events.

## MCP server

`<your instance>/api/mcp` is a stateless Streamable HTTP Model Context Protocol server over `POST`. It accepts only a personal key as `Authorization: Bearer`: no cookies, `X-API-Key` or `API_TOKEN`.

For Claude Code, add this to `.mcp.json` and give the drafting client a `draft` key through `COGSEND_API_KEY`:

```json
{
	"mcpServers": {
		"cogsend": {
			"type": "http",
			"url": "https://cogsend.example.com/api/mcp",
			"headers": { "Authorization": "Bearer ${COGSEND_API_KEY}" }
		}
	}
}
```

| Tools                                                                                                          | Key needed         |
| -------------------------------------------------------------------------------------------------------------- | ------------------ |
| `list_connections`, `list_drafts`, `get_draft`, `list_queue`, `validate_post`, `preview_approval`              | Any readable scope |
| `create_draft`, `update_draft`, `duplicate_draft`, `delete_draft`, `set_draft_variant`, `delete_draft_variant` | `draft`            |
| `approve_draft`, `schedule_draft`, `reschedule_delivery`, `cancel_delivery`, `publish_draft`, `retry_delivery` | `approve_schedule` |

Keep the approval key with the reviewer, separate from the drafting client. Publishing tools can reach real accounts only with a matching approval and publishing enabled. Client confirmation settings are additional protection; the server enforces approval independently. Media, settings, insights and account management are not exposed through MCP. For protected instances, see [Cloudflare Access](access.md#the-paths-it-has-to-let-through).

## Examples

Create a draft with a draft key:

```sh
curl -s -X POST "$APP_URL/api/drafts" \
  -H "Authorization: Bearer $COGSEND_DRAFT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title":"Hello","baseBody":"from a script"}'
```

In a separate reviewer context, fetch and inspect the manual-publishing payload:

```sh
curl -s "$APP_URL/api/drafts/DRAFT_ID/approval?connectionId=CONN_ID" \
  -H "Authorization: Bearer $COGSEND_APPROVAL_KEY"
```

Only after reviewing that exact payload, submit its hash:

```sh
curl -s -X POST "$APP_URL/api/drafts/DRAFT_ID/approval" \
  -H "Authorization: Bearer $COGSEND_APPROVAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"connectionId":"CONN_ID","hash":"REVIEWED_SHA256_HASH","scheduledFor":null}'
```

Publishing is a separate, deliberate action and requires both halt controls to be released:

```sh
curl -s -X POST "$APP_URL/api/drafts/DRAFT_ID/publish" \
  -H "Authorization: Bearer $COGSEND_APPROVAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"connectionIds":["CONN_ID"]}'
```

For scheduling, review and approve the exact `scheduledFor` timestamp first, then pass the identical timestamp to the scheduling endpoint. Changing from scheduled to manual publishing requires approval with `scheduledFor: null`.

## Media

`POST /api/drafts/:id/media` takes a `multipart/form-data` body with one or more `files`, the card's `segmentIndex` (0 for the first) and an optional `altText`. Images go up to 16 MB, an MP4 to 95 MB. An optional `preview-<n>`, a JPEG of at most 1 MB, is shown in place of the n-th file in the app; the original is what gets published.

A larger video goes up in parts, up to 300 MB:

1. `POST /api/drafts/:id/media/uploads` with `{"size": <bytes>, "mime": "video/mp4", "segmentIndex": 0}`. Every check that can refuse the video runs here, before any bytes move. The answer carries `key`, `uploadId`, `size`, `segmentIndex` and `token`, which the next calls send back unchanged, plus `partSize` and `parts`.
2. `PUT /api/drafts/:id/media/uploads/part` for each part `n` from 1 to `parts`, with those five values and `n` in the query string and the bytes as the body. Every part is exactly `partSize` bytes except the last. Each answers `{ "partNumber": n, "etag": "…" }`.
3. `POST /api/drafts/:id/media/uploads/complete` with the five values, `parts` (every answer from step 2, in order) and an optional `altText`. It answers `201` with the stored `media`.

`DELETE /api/drafts/:id/media/uploads` with the five values abandons an upload. The server converts nothing: it takes an MP4 it can read and refuses anything else, and a video must be the only media on its card.

A video's `meta` holds what the server read from it (`durationMs`, `videoCodec`, `audioCodec`, `fps`, and `faststart`, whether its index comes first) and its `cover` once one is set. `PUT /api/drafts/:id/media/cover?mediaId=…` with a JPEG body of at most 8 MB sets the cover, and `DELETE` with the same query removes it.

## Limits

- A body is capped at 100,000 characters, and a variant may carry at most 100 explicit `threadSegments`.
- Each platform's own text and media limits are checked again at publish, so what the API accepts is not necessarily what a platform will take.

## Publishing behaviour

- Both the database kill switch and the environment override must permit publishing. See [Publishing controls](configuration.md#publishing-controls).
- Every manual, scheduled, bulk, retry and MCP delivery needs a matching approval. Existing scheduled posts receive no automatic approval during migration.
- An atomic reservation blocks the same logical content and account within 24 hours, even with another draft ID or time. A permanent dispatch record prevents a target from entering the provider twice. Repeating a successful delivery returns its recorded outcome.
- Once provider dispatch starts, a timeout, lost response, Worker crash, partial thread or video-processing pause remains locked for reconciliation. The fork does not automatically resend or resume it, even if retrying might be safe. This is at-most-once dispatch, not a claim of distributed exactly-once delivery.
- A retry before dispatch still requires matching approval. Changing its time requires a new approval. Do not clear dispatch records to force a retry; there is no automatic reconciliation unlock in this phase.
- Migration `0019` quarantines targets with prior attempts or remote IDs as `legacy_reconciliation_required`. Reconcile uncertain outcomes before considering replacement content.
- Schedule returns 409 for an already published or in-flight destination. It adds the specified accounts; `cancelOthers: true` cancels other waiting destinations. Read the response before treating an action as successful.
- A draft published to every account is read-only. Duplicating it creates a new draft, which still needs approval and remains subject to the duplicate window.
- `publish_audit` records content changes, approvals, scheduling, attempts, successes with platform IDs/URLs, failures, retries, blocked sends and halt changes. Audit and dispatch records survive deletion of draft or target rows. `/approvals` and authenticated `GET /api/publishing` show the latest 100 audit events.
