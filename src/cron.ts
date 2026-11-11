/**
 * Scheduled jobs, one per Cron Trigger in wrangler.jsonc.
 *
 * - CHART_PREWARM (every 30m): refreshes the shared chart + song dataset in KV.
 *   It has a 1-hour TTL, so refreshing on a schedule keeps it perpetually fresh
 *   and user requests never pay the ~3s cost of re-fetching it themselves —
 *   even on a cold start. Scores are not cached here; they stay live on every
 *   request.
 * - LEADERBOARD_CHECK (every 15m): a liveness check for the weekly leaderboard.
 *   getLeaderboard() already refreshes on demand behind a short in-memory poll
 *   guard, and the board is a single sub-second fetch of the official
 *   statmaniax.com board. This just exercises that upstream fetch on a fixed
 *   cadence so an outage or a change to the official API's shape shows up in
 *   the logs instead of only surfacing on a user's widget. (It can't pre-warm
 *   the HTTP handler's cache — that's isolate-local — but there's nothing to
 *   pre-warm.)
 */

import { refreshChartData } from "./data.ts";
import { refreshLeaderboard } from "./leaderboard.ts";

export const CHART_PREWARM = "*/30 * * * *";
export const LEADERBOARD_CHECK = "*/15 * * * *";

export async function prewarmChartData() {
  const start = Date.now();
  const data = await refreshChartData();
  console.log(
    `Pre-warmed chart cache in ${Date.now() - start}ms: ` +
      `${data.charts.length} charts, ${data.songs.length} songs`,
  );
}

export async function checkLeaderboard() {
  const start = Date.now();
  const state = await refreshLeaderboard();
  console.log(
    `Refreshed weekly leaderboard in ${Date.now() - start}ms: ` +
      `period ${state.periodStart}, ${state.players.length} players`,
  );
}
