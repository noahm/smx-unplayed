/**
 * SMX Unplayed Songs API
 *
 * GET /?user=USERNAME[&mode=GAMEMODE][&format=html|json|csv][&details=true]
 *
 * mode options: beginner, easy, hard, wild, dual, full
 * If mode is omitted, returns unplayed counts for all modes. Add details=true
 * (JSON only) to also include each mode's full unplayed/failed chart lists, so
 * every entry under `modes` matches the shape of a single-mode JSON response.
 *
 * format options:
 *   html  rich, responsive page with jacket art (default for web browsers)
 *   json  machine-readable (default for non-browser clients)
 *   csv   spreadsheet-friendly, RFC 4180 escaped (mode required for chart list)
 *
 * The HTML mode page also opens a WebSocket to the 573.no scores feed and
 * strikes through charts live as the player clears them (no refresh needed).
 *
 * This file is just the HTTP handler. The data layer (API access, caches,
 * computation) lives in data.ts; HTML/CSV rendering in render.ts. The page
 * styles and live-update client are static assets in public/, which Workers
 * serves before this handler runs (cache headers in public/_headers).
 */

import {
  computeSummary,
  computeUnplayed,
  getBests,
  getChartData,
  type Mode,
  VALID_MODES,
} from "./data.ts";
import { getLeaderboard, getUserPosition, periodBounds, round2 } from "./leaderboard.ts";
import {
  renderForm,
  renderInvalidMode,
  renderModeCsv,
  renderModePage,
  renderSummaryPage,
} from "./render.ts";

// JSON/CSV responses are data endpoints meant to be called cross-origin from
// other sites' browser code, so they advertise an open CORS policy. A simple GET
// reading the response needs only this header on the response itself (no
// preflight), so there's nothing more to handle. HTML pages don't need it.
const CORS_ORIGIN = "*";

// Response.json plus the cross-origin header.
function apiJson(data: unknown, init?: ResponseInit): Response {
  const res = Response.json(data, init);
  res.headers.set("Access-Control-Allow-Origin", CORS_ORIGIN);
  return res;
}

// Shape one chart for the JSON API: drop the internal song_chart_id and expose
// the song's jacket-art URL (or null) as `jacket`. `cover` holds the same value
// the HTML page renders; renaming it keeps the public field self-describing.
function toJsonChart<T extends { cover: string | null; id: number }>(chart: T) {
  const { cover, id: _id, ...rest } = chart;
  return { ...rest, jacket: cover };
}

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  const user = url.searchParams.get("user")?.trim();
  const modeParam = url.searchParams.get("mode")?.trim().toLowerCase();
  const format = url.searchParams.get("format")?.trim().toLowerCase();
  const detailsParam = url.searchParams.get("details")?.trim().toLowerCase();
  const details = detailsParam === "true" || detailsParam === "1";

  // Content negotiation: explicit ?format wins; otherwise browsers get HTML.
  const accept = req.headers.get("accept") ?? "";
  const wantsHtml = format === "html" || (!format && accept.includes("text/html"));

  // Weekly rank-points leaderboard: a player's position plus a few places
  // above/below, meant for a streamer-widget-style poll rather than a page
  // view. JSON only for now — no ?format=html rendering yet.
  const board = url.searchParams.get("board")?.trim().toLowerCase();
  if (board === "weekly") {
    if (!user) return apiJson({ error: "Missing required query param: user" }, { status: 400 });

    const contextParam = Number.parseInt(url.searchParams.get("context") ?? "", 10);
    const context = Number.isFinite(contextParam) ? Math.min(10, Math.max(1, contextParam)) : 2;

    const state = await getLeaderboard();
    const pos = getUserPosition(state, user, context);
    const { start, end } = periodBounds(state);

    return apiJson({
      user,
      period_start: start,
      period_end: end,
      rank: pos.rank,
      points: round2(pos.points),
      total_players: pos.totalPlayers,
      context: pos.context.map((r) => ({ ...r, points: round2(r.points) })),
    });
  }

  if (!user) {
    if (wantsHtml) return renderForm();
    return apiJson({ error: "Missing required query param: user" }, { status: 400 });
  }

  if (modeParam && !VALID_MODES.includes(modeParam as Mode)) {
    const msg = `Invalid mode. Must be one of: ${VALID_MODES.join(", ")}`;
    if (wantsHtml) return renderInvalidMode(user, msg);
    return apiJson({ error: msg }, { status: 400 });
  }

  const mode = modeParam as Mode | undefined;

  if (mode) {
    const [data, bests] = await Promise.all([getChartData(), getBests(user)]);
    const result = computeUnplayed(data, mode, bests);

    if (wantsHtml) return renderModePage(user, mode, result);
    if (format === "csv") return renderModeCsv(result.unplayed);

    return apiJson({
      user,
      mode,
      played_count: result.playedCount,
      unplayed_count: result.unplayed.length,
      failed_count: result.failed.length,
      unplayed: result.unplayed.map(toJsonChart),
      // Played but not passed, with the best (failing) score so far.
      failed: result.failed.map(toJsonChart),
    });
  }

  const [data, bests] = await Promise.all([getChartData(), getBests(user)]);
  const result = computeSummary(data, bests);

  if (wantsHtml) return renderSummaryPage(user, result);

  // With details=true, expand each mode into its full single-mode payload
  // (counts plus the unplayed/failed chart lists) so callers can pull every
  // mode's songs in one request. Without it, modes stays the lean counts-only
  // summary. Counts and the per-chart JSON shape mirror the single-mode response.
  if (details) {
    const modes: Record<string, unknown> = {};
    for (const m of VALID_MODES) {
      const r = computeUnplayed(data, m, bests);
      modes[m] = {
        played_count: r.playedCount,
        unplayed_count: r.unplayed.length,
        failed_count: r.failed.length,
        unplayed: r.unplayed.map(toJsonChart),
        failed: r.failed.map(toJsonChart),
      };
    }
    return apiJson({ user, total_unplayed: result.totalUnplayed, modes });
  }

  return apiJson({ user, total_unplayed: result.totalUnplayed, modes: result.summary });
}
