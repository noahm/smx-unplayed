/**
 * Weekly rank-points leaderboard, proxied straight from the official SMX site.
 *
 * statmaniax.com publishes the same "Weekly Rank" board the SMX app shows, and
 * it is the source of truth. We used to *reconstruct* this board from the
 * third-party api.smx.573.no scores feed — summing (score/1000)*difficulty^2
 * over each player's best score per chart in the period — but that mirror's
 * scores don't perfectly match SMX's own backend, so per-player totals drifted
 * a few percent in both directions (and some official totals were literally
 * unreachable from the mirror's data: a top player's official total exceeded a
 * perfect-play ceiling on the charts the mirror had for them). So we dropped
 * the reconstruction and just serve the official numbers.
 *
 * GET https://statmaniax.com/api/weekly_rank/total/<offset>/<limit> returns the
 * whole board — one row per player, already sorted by points descending. The
 * relevant fields per row:
 *   - `rank`        the player's total points for the period (a string; the
 *                   name is misleading — it is the score total, not a position)
 *   - `username`    display name (case varies; match case-insensitively)
 *   - `start_date`  "YYYY-MM-DD HH:MM:SS" period start (a Tuesday, treated UTC)
 *   - `graph`/0..6  per-day cumulative totals (unused here)
 * A player's placement is just their index in the returned order, with standard
 * competition ranking for ties. The board is only ~500 rows; we pull it a
 * modest page at a time and stop at the first short page, so there's no
 * per-chart math and no persisted state — a short in-memory cache collapses a
 * burst of widget polls into one refresh.
 */

// Paged fetch. The official endpoint is /total/<offset>/<limit>; we walk offsets
// a page at a time instead of asking for the whole board in one oversized
// request — a smaller footprint on an undocumented endpoint. PAGE_CAP bounds the
// walk so a response that never shortens can't loop forever (~500 players today,
// so the cap is generous headroom).
const BOARD_BASE = "https://statmaniax.com/api/weekly_rank/total";
const PAGE_SIZE = 250;
const PAGE_CAP = 40;

// Raw row shape from the official API (only the fields we read).
interface OfficialRow {
  username: string;
  rank: string; // total points for the period, as a string
  start_date: string; // "YYYY-MM-DD HH:MM:SS"
}

// The board projected to what we serve, kept in the API's descending-points
// order so a player's placement is their index. `periodStart` is the date
// portion of the API's start_date (or "" if the board came back empty).
export interface LeaderboardState {
  periodStart: string; // "YYYY-MM-DD"
  players: { username: string; points: number }[];
  fetchedAt: number;
}

// In-memory cache (isolate-local, not persisted — the fetch is cheap enough
// that a cold isolate just refetches). The poll guard collapses the burst of
// near-simultaneous widget hits after a streamer's score posts into one fetch.
const LB_POLL_MIN_MS = 30 * 1000;
let memState: LeaderboardState | null = null;

// Fetches the official board and projects it. Exported so the backstop cron and
// the on-demand path share one code path. Throws on a failed/garbled fetch;
// getLeaderboard() decides whether to surface that or serve a stale copy.
async function fetchPage(offset: number): Promise<OfficialRow[]> {
  const res = await fetch(`${BOARD_BASE}/${offset}/${PAGE_SIZE}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`weekly_rank fetch failed: ${res.status}`);
  const json = (await res.json()) as { weekly_rank?: OfficialRow[] };
  return json.weekly_rank ?? [];
}

export async function refreshLeaderboard(): Promise<LeaderboardState> {
  // Walk offsets until a page comes back short (the last page). The rows are
  // already sorted descending, so concatenating pages preserves board order.
  const rows: OfficialRow[] = [];
  for (let page = 0; page < PAGE_CAP; page++) {
    const batch = await fetchPage(page * PAGE_SIZE);
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }

  const players = rows
    .map((r) => ({ username: r.username, points: Number(r.rank) }))
    .filter((p) => p.username && Number.isFinite(p.points));

  const state: LeaderboardState = {
    periodStart: (rows[0]?.start_date ?? "").slice(0, 10),
    players,
    fetchedAt: Date.now(),
  };
  memState = state;
  return state;
}

// Current board, refreshing upstream only once per poll-guard window so a burst
// of widget requests collapses into a single fetch. On a fetch error, serve the
// last good copy if we have one rather than failing the widget outright.
export async function getLeaderboard(): Promise<LeaderboardState> {
  if (memState && Date.now() - memState.fetchedAt < LB_POLL_MIN_MS) return memState;
  try {
    return await refreshLeaderboard();
  } catch (e) {
    if (memState) return memState;
    throw e;
  }
}

export interface LeaderboardRow {
  rank: number; // 1-based placement
  username: string;
  points: number;
}

export interface UserPosition {
  rank: number | null; // null if the user isn't on the board this period
  points: number;
  totalPlayers: number;
  context: LeaderboardRow[];
}

// Kept for API compatibility with main.ts. Official points are already whole
// numbers, so this is effectively a no-op now, but callers still round through
// it so the field type stays stable if the source ever returns fractions.
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Attach standard competition ("1224") placement to each row: tied players
// share a rank and the next distinct points value skips ahead by the tie size.
// Assumes `players` is already in descending-points order (the API's order).
function rankedRows(state: LeaderboardState): LeaderboardRow[] {
  const rows: LeaderboardRow[] = [];
  let rank = 0;
  let prevPoints: number | null = null;
  state.players.forEach((p, i) => {
    if (prevPoints === null || p.points !== prevPoints) {
      rank = i + 1;
      prevPoints = p.points;
    }
    rows.push({ rank, username: p.username, points: p.points });
  });
  return rows;
}

// The player's placement plus `context` rows above and below. If the player
// isn't on the board this period, returns rank: null and the top of the board.
export function getUserPosition(
  state: LeaderboardState,
  user: string,
  context: number,
): UserPosition {
  const rows = rankedRows(state);
  const idx = rows.findIndex((r) => r.username.toLowerCase() === user.toLowerCase());

  if (idx === -1) {
    return { rank: null, points: 0, totalPlayers: rows.length, context: rows.slice(0, context * 2 + 1) };
  }

  const lo = Math.max(0, idx - context);
  const hi = Math.min(rows.length, idx + context + 1);
  return {
    rank: rows[idx].rank,
    points: rows[idx].points,
    totalPlayers: rows.length,
    context: rows.slice(lo, hi),
  };
}

// Period boundaries, for clients that want to show a countdown or label. The
// official board's start_date is a Tuesday midnight; we treat it as UTC (the
// same boundary we reported before) and the period runs a fixed 7 days. Falls
// back to empty strings if the board came back without a start_date.
export function periodBounds(state: LeaderboardState): { start: string; end: string } {
  const start = new Date(state.periodStart + "T00:00:00Z");
  if (Number.isNaN(start.getTime())) return { start: "", end: "" };
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}
