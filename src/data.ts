/**
 * Data layer for SMX Unplayed Songs.
 *
 * Owns the 573.no API access, the two caches (hour-long chart/song data in KV,
 * persistent per-user scores in KV refreshed incrementally), and the pure
 * functions that turn that data into unplayed-chart lists and the all-modes
 * summary.
 *
 * Uses api.smx.573.no as the single source of truth, matching by song_chart_id.
 */

import { env } from "cloudflare:workers";

export const API_BASE = "https://api.smx.573.no";
export const COVER_BASE = "https://data.stepmaniax.com/";

export const VALID_MODES = ["beginner", "easy", "hard", "wild", "dual", "full"] as const;
export type Mode = (typeof VALID_MODES)[number];

// Map mode name → 573.no difficulty_name values
export const MODE_DIFF_NAMES: Record<Mode, string[]> = {
  beginner: ["basic"],
  easy: ["easy", "easy2"],
  hard: ["hard", "hard2"],
  wild: ["wild"],
  dual: ["dual", "dual2"],
  full: ["full", "full2"],
};

// Map 573.no difficulty_name → user-facing display name
const DIFF_DISPLAY: Record<string, string> = {
  basic: "beginner",
  easy: "easy",
  easy2: "easy+",
  hard: "hard",
  hard2: "hard+",
  wild: "wild",
  dual: "dual",
  dual2: "dual+",
  full: "full",
  full2: "full+",
};

export interface Chart573 {
  _id: number;
  difficulty: number;
  difficulty_name: string;
  song_id: number;
}

export interface Song573 {
  _id: number;
  title: string;
  subtitle: string;
  artist: string;
  cover_thumb?: string;
}

// One chart the player has scored on, collapsed across all their attempts.
// `passed` is true if any attempt cleared (lifebar survived to the end);
// `best_score` is the best score in the chart's reported category — the best
// passing score when passed, otherwise the best failing score.
export interface ChartScore {
  song_chart_id: number;
  difficulty_name: string;
  passed: boolean;
  best_score: number;
}

export interface UnplayedChart {
  id: number;
  title: string;
  artist: string;
  lvl: number;
  diff: string;
  cover: string | null;
}

// A chart the player has played but never passed, plus their best (failing)
// score on it so far.
export interface FailedChart extends UnplayedChart {
  score: number;
}

export interface ChartData {
  fetchedAt: number;
  charts: Chart573[];
  songs: Song573[];
}

export interface ModeResult {
  unplayed: UnplayedChart[];
  failed: FailedChart[];
  playedCount: number;
}

export type ModeSummary = Record<
  string,
  { played_count: number; unplayed_count: number; failed_count: number }
>;

export interface SummaryResult {
  totalUnplayed: number;
  summary: ModeSummary;
}

// ---- 573.no API paging ----------------------------------------------------

// Total number of rows a query would return, or null if the API can't tell us
// (in which case callers fall back to sequential paging).
async function fetchCount(
  endpoint: string,
  query: Record<string, unknown>,
): Promise<number | null> {
  try {
    const q = JSON.stringify({ ...query, _count: true });
    const res = await fetch(`${API_BASE}/${endpoint}?q=${encodeURIComponent(q)}`);
    if (!res.ok) return null;
    const json = (await res.json()) as { count?: unknown };
    return typeof json?.count === "number" ? json.count : null;
  } catch {
    return null;
  }
}

const PAGE_SIZE = 100;
const PAGE_CONCURRENCY = 8;

async function fetchPage<T>(
  endpoint: string,
  query: Record<string, unknown>,
  skip: number,
): Promise<T[]> {
  const q = JSON.stringify({ ...query, _take: PAGE_SIZE, _skip: skip });
  const res = await fetch(`${API_BASE}/${endpoint}?q=${encodeURIComponent(q)}`);
  if (!res.ok) return [];
  return (await res.json()) as T[];
}

export async function fetchAllPages<T>(
  endpoint: string,
  query: Record<string, unknown>,
): Promise<T[]> {
  // When the total is known up front we can fetch every page in parallel
  // (in bounded chunks) instead of walking them one request at a time.
  const total = await fetchCount(endpoint, query);

  if (total === null) {
    const results: T[] = [];
    let skip = 0;
    while (true) {
      const batch = await fetchPage<T>(endpoint, query, skip);
      results.push(...batch);
      if (batch.length < PAGE_SIZE) break;
      skip += PAGE_SIZE;
    }
    return results;
  }

  const pages = Math.ceil(total / PAGE_SIZE);
  const results: T[] = [];
  for (let i = 0; i < pages; i += PAGE_CONCURRENCY) {
    const chunk: Promise<T[]>[] = [];
    for (let p = i; p < Math.min(i + PAGE_CONCURRENCY, pages); p++) {
      chunk.push(fetchPage<T>(endpoint, query, p * PAGE_SIZE));
    }
    for (const batch of await Promise.all(chunk)) results.push(...batch);
  }
  return results;
}

// ---- Compressed KV codec --------------------------------------------------

// Our payloads are repetitive JSON that gzips to ~6-8% of its size, so
// everything we persist goes through these two helpers. Values are stored as
// raw gzip bytes, byte-for-byte what the Val Town blobs held, so migrated keys
// read back unchanged. Compression uses the runtime's native CompressionStream.
// The reader returns undefined on a missing key.

async function gzipJSON(value: unknown): Promise<Uint8Array> {
  const input = new TextEncoder().encode(JSON.stringify(value));
  const stream = new Response(input).body!.pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function setJSONCompressed(key: string, value: unknown): Promise<void> {
  await env.CACHE.put(key, await gzipJSON(value));
}

export async function getJSONCompressed<T>(key: string): Promise<T | undefined> {
  const body = await env.CACHE.get(key, "stream");
  if (!body) return undefined;
  const stream = body.pipeThrough(new DecompressionStream("gzip"));
  return (await new Response(stream).json()) as T;
}

// ---- Chart + song data cache ----------------------------------------------

// The enabled-chart set and song metadata are identical for every user and only
// change when SMX adds songs, yet fetching them (dozens of paged calls) is by
// far the most expensive part of a request. Cache the projected data behind an
// in-memory layer (free while the isolate stays warm) backed by KV (shared
// across isolates, survives cold starts). Scores are intentionally NOT cached
// here, so a player's unplayed list updates the moment they play.

const CHART_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
// v2: stored gzip-compressed (see setJSONCompressed). Bumped from v1 so the
// old uncompressed blob isn't read as gzip.
const CHART_CACHE_KEY = "smx-unplayed:chartdata:v2";

let memoryCache: ChartData | null = null;

function isFresh(data: ChartData): boolean {
  return Date.now() - data.fetchedAt < CHART_CACHE_TTL_MS;
}

async function loadChartData(): Promise<ChartData> {
  const allDiffNames = VALID_MODES.flatMap((m) => MODE_DIFF_NAMES[m]);
  // The API stores `is_enabled` inconsistently — recently-added charts that
  // haven't been re-saved come back as the integer `1`, while touched rows are
  // the boolean `true`. A plain `is_enabled: true` match drops the integer rows,
  // silently omitting whole charts (e.g. "Calling" dual 14). The query treats an
  // array as an IN-match, so list both literals to keep the integer-1 charts.
  // Don't "simplify" this to `is_enabled: true` — that reintroduces the bug.
  const [charts, songs] = await Promise.all([
    fetchAllPages<Chart573>("charts", { difficulty_name: allDiffNames, is_enabled: [true, 1] }),
    fetchAllPages<Song573>("songs", {}),
  ]);
  // Project to just the fields we use so the cached value stays small.
  return {
    fetchedAt: Date.now(),
    charts: charts.map((c) => ({
      _id: c._id,
      difficulty: c.difficulty,
      difficulty_name: c.difficulty_name,
      song_id: c.song_id,
    })),
    songs: songs.map((s) => ({
      _id: s._id,
      title: s.title,
      subtitle: s.subtitle,
      artist: s.artist,
      cover_thumb: s.cover_thumb,
    })),
  };
}

// Force a fresh fetch and write it to both cache layers. Exported so the
// scheduled handler (cron.ts) can pre-warm KV, keeping user requests off the
// slow path even after a cold start.
export async function refreshChartData(): Promise<ChartData> {
  const data = await loadChartData();
  memoryCache = data;
  try {
    await setJSONCompressed(CHART_CACHE_KEY, data);
  } catch {
    // A failed cache write shouldn't fail the caller.
  }
  return data;
}

export async function getChartData(): Promise<ChartData> {
  if (memoryCache && isFresh(memoryCache)) return memoryCache;

  try {
    const cached = await getJSONCompressed<ChartData>(CHART_CACHE_KEY);
    if (cached && isFresh(cached)) {
      memoryCache = cached;
      return cached;
    }
  } catch {
    // Ignore KV read errors; fall through to a fresh fetch.
  }

  return await refreshChartData();
}

// ---- Per-user score cache (persistent, incremental) -----------------------

// A player's scores are immutable: once recorded, a score never changes, and
// playing a chart only ever adds rows. So rather than re-fetching a player's
// whole history on a short TTL, we persist their played-chart set per user in
// KV and refresh it incrementally — each request asks 573.no only for scores
// recorded since our last fetch (updated_at >= the stored high-water mark) and
// merges the new charts in. The common nothing-new case costs one cheap, near-
// empty query and no KV write, while the player's lists still update the
// moment they play. A short in-memory poll guard collapses the typical summary
// (all modes) → mode-click burst into a single upstream poll.
//
// We group upstream by (song_chart_id, cleared) so each chart can come back as
// up to two rows — its best passing score and its best failing score. Passing
// is a superset of "played", so once a chart has any passing score we treat it
// as passed and ignore its fails; a chart with only fails is "played but not
// passed". This is what lets us report the failed-but-not-passed breakout.

// v3: stored gzip-compressed (see setJSONCompressed). Bumped from v2 so the old
// uncompressed per-user blobs aren't read as gzip; a missing key just triggers
// one full re-fetch per user, then incremental resumes.
const SCORE_CACHE_KEY_PREFIX = "smx-unplayed:scores:v3:";
const SCORE_POLL_MIN_MS = 15 * 1000;

// Persisted per user. `charts` is one collapsed record per song_chart_id;
// `lastScoreAt` is the max updated_at (ISO 8601) seen so far, or null before the
// first fetch.
interface UserScores {
  lastScoreAt: string | null;
  charts: ChartScore[];
}

// Raw grouped score row, projected to the fields we keep plus the timestamp we
// need to advance the high-water mark.
interface ScoreRaw {
  song_chart_id: number;
  chart: { difficulty_name: string };
  cleared: boolean;
  score: number;
  updated_at: string;
}

export const ALL_DIFF_NAMES = VALID_MODES.flatMap((m) => MODE_DIFF_NAMES[m]);

// In-memory layer: the persisted set plus when we last polled upstream (the
// poll time is intentionally not persisted — it's only an isolate-local guard).
const scoreCache = new Map<string, { scores: UserScores; polledAt: number }>();

// Usernames are case-insensitive, so normalize to lower case for cache keys —
// otherwise "Cathadan" and "cathadan" would get separate keys / map entries
// despite being the same player. The upstream query is left as-is.
function normalizeUser(user: string): string {
  return user.toLowerCase();
}

function scoreBlobKey(user: string): string {
  return SCORE_CACHE_KEY_PREFIX + encodeURIComponent(normalizeUser(user));
}

// Scores recorded at or after `since` (null fetches the full history). Grouped
// by (song_chart_id, cleared) so we get the player's best passing score and best
// failing score per chart — enough to tell passed from played-but-not-passed.
async function fetchScoresSince(user: string, since: string | null): Promise<ScoreRaw[]> {
  const query: Record<string, unknown> = {
    "gamer.username": user,
    "chart.difficulty_name": ALL_DIFF_NAMES,
    _group_by: ["song_chart_id", "cleared"],
  };
  if (since) query["updated_at"] = { gte: since };
  const raw = await fetchAllPages<ScoreRaw>("scores", query);
  return raw.map((b) => ({
    song_chart_id: b.song_chart_id,
    chart: { difficulty_name: b.chart.difficulty_name },
    cleared: b.cleared,
    score: b.score,
    updated_at: b.updated_at,
  }));
}

// Fold newly fetched grouped rows into the existing set and advance the high-
// water mark to the latest updated_at observed. Passing always wins: a cleared
// row marks the chart passed (keeping the best passing score), while a non-
// cleared row only matters until the chart has a pass, where it tracks the best
// failing score.
function mergeScores(existing: UserScores, incoming: ScoreRaw[]): UserScores {
  const byId = new Map(existing.charts.map((c) => [c.song_chart_id, { ...c }]));
  let lastScoreAt = existing.lastScoreAt;
  let lastMs = lastScoreAt ? Date.parse(lastScoreAt) : -Infinity;
  for (const row of incoming) {
    const cur = byId.get(row.song_chart_id);
    if (!cur) {
      byId.set(row.song_chart_id, {
        song_chart_id: row.song_chart_id,
        difficulty_name: row.chart.difficulty_name,
        passed: row.cleared,
        best_score: row.score,
      });
    } else if (row.cleared) {
      // Flip to passed (best_score switches to the passing score), or keep the
      // best passing score if already passed.
      cur.best_score = cur.passed ? Math.max(cur.best_score, row.score) : row.score;
      cur.passed = true;
    } else if (!cur.passed) {
      // Still only fails so far: track the best failing score.
      cur.best_score = Math.max(cur.best_score, row.score);
    }
    const ms = Date.parse(row.updated_at);
    if (Number.isFinite(ms) && ms > lastMs) {
      lastMs = ms;
      lastScoreAt = row.updated_at;
    }
  }
  return { lastScoreAt, charts: [...byId.values()] };
}

// Every chart the player has a score on, across all modes, collapsed to one
// record each. Mode pages filter this down themselves (computeUnplayed only
// checks membership by chart id, so charts from other modes never match), so one
// set serves summary and modes.
export async function getBests(user: string): Promise<ChartScore[]> {
  // Skip the upstream poll if we refreshed this user very recently — this is
  // what makes the summary → mode-click hop reuse a single fetch. Key the cache
  // by the normalized (lower-cased) username so casing variants share an entry.
  const cacheKey = normalizeUser(user);
  const mem = scoreCache.get(cacheKey);
  if (mem && Date.now() - mem.polledAt < SCORE_POLL_MIN_MS) return mem.scores.charts;

  let existing = mem?.scores;
  if (!existing) {
    try {
      existing = await getJSONCompressed<UserScores>(scoreBlobKey(user));
    } catch {
      // Ignore KV read errors; fall through to a full fetch.
    }
  }
  existing ??= { lastScoreAt: null, charts: [] };

  const incoming = await fetchScoresSince(user, existing.lastScoreAt);
  const merged = mergeScores(existing, incoming);

  // Opportunistically drop stale entries so the map can't grow unbounded.
  if (scoreCache.size > 64) {
    for (const [k, v] of scoreCache) {
      if (Date.now() - v.polledAt >= SCORE_POLL_MIN_MS) scoreCache.delete(k);
    }
  }
  scoreCache.set(cacheKey, { scores: merged, polledAt: Date.now() });

  // Only write back when the high-water mark actually moved, so the common
  // nothing-new poll stays a pure read. Any new score (new chart, a pass on a
  // previously-failed chart, or a better score) carries a newer updated_at, so
  // a moved watermark captures every state change.
  if (merged.lastScoreAt !== existing.lastScoreAt) {
    try {
      await setJSONCompressed(scoreBlobKey(user), merged);
    } catch {
      // A failed cache write shouldn't fail the caller.
    }
  }

  return merged.charts;
}

// ---- Computation ----------------------------------------------------------

// The unplayed charts for one mode (never scored), plus the charts the player
// has played but never passed (with their best failing score), plus how many of
// that mode's charts the player has played at all. Counts plays against the live
// enabled-chart set so scores on since-disabled charts can't push played +
// unplayed past the total. A failed chart still counts as played.
export function computeUnplayed(data: ChartData, mode: Mode, scores: ChartScore[]): ModeResult {
  const diffNames = MODE_DIFF_NAMES[mode];
  const charts = data.charts.filter((c) => diffNames.includes(c.difficulty_name));
  const songMap = new Map(data.songs.map((s) => [s._id, s]));
  const scoreById = new Map(scores.map((s) => [s.song_chart_id, s]));

  const toChart = (c: Chart573): UnplayedChart => {
    const song = songMap.get(c.song_id);
    const title = song?.subtitle
      ? `${song.title} (${song.subtitle})`
      : (song?.title ?? "Unknown");
    return {
      id: c._id,
      title,
      artist: song?.artist ?? "Unknown",
      lvl: c.difficulty,
      diff: DIFF_DISPLAY[c.difficulty_name] ?? c.difficulty_name,
      cover: song?.cover_thumb ? COVER_BASE + song.cover_thumb : null,
    };
  };

  const unplayed: UnplayedChart[] = [];
  const failed: FailedChart[] = [];
  let playedCount = 0;
  for (const c of charts) {
    const sc = scoreById.get(c._id);
    if (!sc) {
      unplayed.push(toChart(c));
      continue;
    }
    playedCount++;
    if (!sc.passed) failed.push({ ...toChart(c), score: sc.best_score });
  }

  return { unplayed, failed, playedCount };
}

// All-modes summary. Intersects the player's scored chart ids with the live
// enabled-chart set (rather than subtracting raw play counts) so plays on
// since-disabled charts don't undercount unplayed or disagree with mode lists.
// `failed_count` is the played-but-not-passed subset of played_count.
export function computeSummary(data: ChartData, scores: ChartScore[]): SummaryResult {
  const enabledIds = new Set(data.charts.map((c) => c._id));

  const totalByDiff = new Map<string, number>();
  for (const c of data.charts) {
    totalByDiff.set(c.difficulty_name, (totalByDiff.get(c.difficulty_name) ?? 0) + 1);
  }

  const playedByDiff = new Map<string, number>();
  const failedByDiff = new Map<string, number>();
  for (const sc of scores) {
    if (!enabledIds.has(sc.song_chart_id)) continue; // skip plays on disabled charts
    const d = sc.difficulty_name;
    playedByDiff.set(d, (playedByDiff.get(d) ?? 0) + 1);
    if (!sc.passed) failedByDiff.set(d, (failedByDiff.get(d) ?? 0) + 1);
  }

  const summary: ModeSummary = {};
  let totalUnplayed = 0;
  for (const m of VALID_MODES) {
    let played = 0;
    let total = 0;
    let failed = 0;
    for (const d of MODE_DIFF_NAMES[m]) {
      played += playedByDiff.get(d) ?? 0;
      total += totalByDiff.get(d) ?? 0;
      failed += failedByDiff.get(d) ?? 0;
    }
    const unplayed = total - played;
    summary[m] = { played_count: played, unplayed_count: unplayed, failed_count: failed };
    totalUnplayed += unplayed;
  }

  return { totalUnplayed, summary };
}
