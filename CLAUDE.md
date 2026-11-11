# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Cloudflare Worker: a web app + JSON/CSV API that, given a StepManiaX username,
lists the charts that player has never scored on (their "unplayed" songs), with
a live view that crosses charts off in real time as they clear them.

- Live endpoint: `https://unplayed.smx.tools/` (a Workers custom domain, see
  `routes` in `wrangler.jsonc`; the `*.workers.dev` URL is off)
- Runtime: Cloudflare Workers (`wrangler.jsonc`): KV for the caches, Cron
  Triggers for the scheduled jobs, `public/` served as static assets.
- History: this was the `cathadan/smx-unplayed-songs` val on Val Town (Deno) until
  Val Town shut down. `smx-unplayed.val.run` redirects here.

`API_DOCS.md` is a local cache of
<https://raw.githubusercontent.com/DesktopMan/smx-api-docs/refs/heads/main/README.md>.
**Note:** it documents the third-party `api.smx.573.no` API (authored by
DesktopMan), not this project. Its wording ("my public API", "this repo serves
as the documentation and issue tracker") describes that upstream repo; this
Worker is only a *consumer* of that API.

## Working on the code

- `npm run dev` — local `wrangler dev` (local KV). Add `--test-scheduled` and hit
  `/__scheduled?cron=*/30+*+*+*+*` to run a cron job.
- `npm run typecheck` — `tsc`. Run `npm run typegen` after editing
  `wrangler.jsonc` to regenerate `worker-configuration.d.ts`.
- `npm run deploy` — `wrangler deploy`.
- Exercise paths with `?user=<name>`, plus `&mode=<mode>` and
  `&format=json|csv|html`. `npx wrangler tail` streams production logs.

## Files and how they fit together

The HTTP handler is thin; logic is split into a data layer, a render layer, and
two static browser assets.

- **`src/index.ts`** (Worker entry) — `fetch` → `main.ts`, `scheduled` →
  `cron.ts`, dispatching on the cron expression.
- **`src/main.ts`** (HTTP handler) — routing and content negotiation only.
  Dispatches on `?user`, `?mode`, `?format`, `?details`. `?format` wins;
  otherwise browsers (Accept: text/html) get HTML and everything else gets JSON.
  No `mode` → all-modes summary; with `mode` → that mode's unplayed/failed
  lists. `?details=true` (JSON, no-mode only) expands each `modes.<mode>` entry
  from counts-only to the full single-mode payload (adds `unplayed`/`failed`
  arrays); the default stays lean for backward compatibility. JSON/CSV responses
  send `Access-Control-Allow-Origin: *`; HTML does not.
- **`src/data.ts`** (data layer) — all `api.smx.573.no` access (paged via the
  `_count` + parallel `_skip` pattern), the two caches, and the pure
  `computeUnplayed` / `computeSummary` functions. Source of truth is matched by
  `song_chart_id`.
- **`src/render.ts`** — turns computed results into HTML/CSV `Response`s
  (`renderForm`, `renderModePage`, `renderSummaryPage`, `renderModeCsv`, ...).
  Holds inline `<script>` blocks for form feedback and client-side level
  filtering; the page `<link>`s/`<script>`s the static assets rather than
  inlining them.
- **`src/icons.ts`** — `MODE_ICONS`, inline SVG per mode, used by `render.ts`.
- **`public/styles.css`** / **`public/live.js`** — static assets, served by
  Workers before the handler runs, with a 10-minute browser cache set in
  `public/_headers`. `live.js` is the real-time client (see below).
- **`src/cron.ts`** — the two scheduled jobs. Their cron strings must match
  `triggers.crons` in `wrangler.jsonc`.
  - `*/30` pre-warms the chart/song cache via `refreshChartData()`, so user
    requests never pay the cold fetch; 30m stays inside the 1-hour TTL.
  - `*/15` is a leaderboard liveness check: it exercises the upstream board
    fetch on a fixed cadence so an outage or an API-shape change surfaces in the
    logs rather than only on a user's widget. It can't pre-warm the HTTP
    isolate's in-memory cache, but the on-demand fetch is a cheap sub-second
    call, so there's nothing to pre-warm.
- **`src/leaderboard.ts`** (data layer) — the weekly rank-points leaderboard (see
  below). Proxies the official statmaniax.com board with a short in-memory
  cache; no 573.no access, no per-chart math, no persisted state. `main.ts`'s
  `?board=weekly` route and the 15m cron are its only two callers.

## Weekly leaderboard (`?board=weekly`)

`GET /?board=weekly&user=USERNAME[&context=N]` returns one player's position in
the current week's rank-points leaderboard plus `N` places above/below (default
2, max 10) — built for a streamer-widget-style poll rather than a page view.
JSON only for now; no `?format=html` rendering yet.

- **Source of truth**: the official SMX board at
  `https://statmaniax.com/api/weekly_rank/total/<offset>/<limit>`. We proxy it
  verbatim — the response's `rank` field is the player's **total points** for
  the period (the field name is misleading; it's a score total, not a
  placement), and rows come back already sorted by points descending. We page
  through it (`/<offset>/250`, walking offsets until a short page ends it — ~500
  players is 3 pages today) rather than requesting the whole board at once, to
  stay light on an undocumented endpoint. A player's placement is their index in
  the concatenated order, with standard competition ("1224") ranking for ties.
  Points are already whole numbers.
- **Why we don't compute it ourselves**: we used to *reconstruct* this board
  from the 573.no scores feed — `(score / 1000) * difficulty^2` summed over each
  player's best score per chart in the period. That formula is essentially
  correct (it reproduced several players to within 1 point), but the 573.no
  mirror's scores don't match SMX's own backend closely enough: per-player
  totals drifted a few percent in **both** directions, and some official totals
  were literally unreachable from the mirror's data (one top player's official
  total exceeded a perfect-play ceiling on the charts the mirror had for them).
  No formula/period/timestamp change reconciles that — it's an upstream data
  gap — so we abandoned the reconstruction and read the official numbers. If you
  ever need the formula again, it lived in the Val Town version history of
  `leaderboard.ts` (before this repo existed).
- **Period**: taken from the board's own `start_date` (a Tuesday midnight,
  treated as UTC), running a fixed 7 days. We no longer derive the boundary
  ourselves.
- **Scope**: global across every player on the board that period, not filtered
  to one arcade/location.
- **State**: none persisted. `refreshLeaderboard()` fetches and projects the
  board; `getLeaderboard()` serves an isolate-local in-memory copy, refreshing
  at most once per `LB_POLL_MIN_MS` (30s) so a burst of widget polls collapses
  into one upstream fetch, and falling back to the last good copy if a fetch
  fails. The same `refreshLeaderboard()` backs the cron liveness check.

## Domain model (the parts worth knowing before editing)

- **Modes vs. difficulty names.** The six user-facing modes (`beginner`, `easy`,
  `hard`, `wild`, `dual`, `full`, in `VALID_MODES`) each map to one or more
  573.no `difficulty_name` values via `MODE_DIFF_NAMES` (e.g. `easy` →
  `["easy","easy2"]`), and those names map to display labels via `DIFF_DISPLAY`
  (`easy2` → `easy+`). Keep these three in sync when touching modes.
- **passed vs. played-but-not-passed.** A chart is *played* if any score exists,
  *passed* if any attempt cleared. Scores are fetched grouped by
  `(song_chart_id, cleared)` so each chart yields up to two rows (best passing,
  best failing). Passing always wins: a pass marks the chart passed and never
  downgrades. The "failed" list is played-but-never-passed, carrying the best
  failing score. This passed-always-wins rule is mirrored in `live.js`.
- **Counts use the live enabled-chart set.** `computeSummary` intersects the
  player's scored chart ids with the currently enabled charts (rather than
  subtracting raw play counts) so scores on since-disabled charts can't push
  played past the total or disagree with mode lists.

## Caching (two distinct strategies — don't conflate them)

- **Chart + song data** is identical for all users and expensive to fetch, so
  it's cached: an in-memory layer (free while the isolate is warm) backed by KV
  (`smx-unplayed:chartdata:v2`, 1-hour TTL checked against `fetchedAt`), kept
  fresh by the 30m cron. `getChartData()` reads it; `refreshChartData()` forces a refetch.
- **Per-user scores are NOT on a TTL.** Scores are immutable and only ever
  added, so each user's collapsed played-chart set is persisted per user
  (`smx-unplayed:scores:v3:<user>`) and refreshed **incrementally**: every
  request queries 573.no only for `updated_at >= ` the stored high-water mark
  and merges. The common nothing-new case is one cheap query and no KV write,
  so a player's list updates the moment they play. A 15s in-memory poll guard
  (`SCORE_POLL_MIN_MS`) collapses the summary→mode-click burst into one poll.

If you add a field to the cached projection or change the merge semantics, bump
the cache key version (`:v2`/`:v3`) so stale values don't break readers. All KV
values are gzip-compressed JSON (`setJSONCompressed` / `getJSONCompressed`), the
same bytes the Val Town blobs held, so the migrated keys read back unchanged.
KV is eventually consistent (a write can take up to ~60s to show in other
locations), which is fine here: the in-memory layer covers the same isolate,
and a stale read just re-polls from an older watermark.

## Live updates (`live.js`)

The mode page opens a WebSocket to the 573.no scores feed filtered to the user
and reacts to each score instantly: a cleared score crosses the chart off as
passed; a non-cleared score moves it into the "played but not passed" section.
It only touches charts currently rendered, so replays of passed charts are
ignored. It's mobile-resilient: on returning to the foreground it REST-fetches
scores missed while backgrounded (using a server-seeded `since` watermark, never
the phone's clock) and reconnects with backoff.

Several display helpers are **deliberately duplicated** between `render.ts` and
`live.js` so server- and client-rendered cards/stats read identically:
`pctComplete`/`pctStr` (percent that never rounds up to 100) and
`formatScore`/`fmtScore` (thousands grouping). The failed-section markup is also
mirrored. Change both sides together.

## Upstream API (api.smx.573.no)

Full reference in `API_DOCS.md`. Key points the code relies on: query via a
single URL-encoded JSON `q` param; special fields `_count`, `_take`/`_skip`
(max 100/page), `_group_by`, `_order`; operators `gte`/`lt`/etc.; and WebSocket
endpoints (`scores`, `charts`, `songs`) that accept the same `q` matching. The
API is public, unauthenticated, free for non-commercial use, and unaffiliated
with Step Revolution.
