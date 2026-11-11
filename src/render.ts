/**
 * Presentation layer: turns computed results into HTTP Responses (HTML, CSV).
 *
 * Styling lives in styles.css and the live-update client in live.js; both are
 * served as static assets (public/), so pages just <link>/<script> them rather
 * than inlining big blobs. The mode page injects a tiny per-request config
 * (username + server timestamp) for live.js to read.
 */

import {
  type Mode,
  type ModeResult,
  type SummaryResult,
  type UnplayedChart,
  VALID_MODES,
} from "./data.ts";
import { MODE_ICONS } from "./icons.ts";

// Wrap a difficulty icon in a sized span. `sm` is the inline header variant;
// the default is the larger mode-card variant.
function diffIcon(mode: Mode, sm = false): string {
  return `<span class="dicon${sm ? " sm" : ""}" aria-hidden="true">${MODE_ICONS[mode]}</span>`;
}

// Percent of a mode's charts done, as a display string. We never round up to
// "100": only a genuinely complete set (done >= total) shows 100. An incomplete
// set that would otherwise round to 100 shows one floored decimal instead, e.g.
// "99.8". Mirrored by pctStr in live.js.
function pctComplete(done: number, total: number): string {
  if (total <= 0) return "0";
  if (done >= total) return "100";
  const raw = (done / total) * 100;
  if (Math.round(raw) >= 100) return (Math.floor(raw * 10) / 10).toFixed(1);
  return String(Math.round(raw));
}

// Group a score into thousands (e.g. 60085 → "60,085"). Mirrored by fmtScore in
// live.js so server- and client-rendered failed cards read the same.
function formatScore(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// A level filter bar for the mode page: an "All" tab plus one tab per chart
// level present in the unplayed list (ascending), each carrying a count of how
// many unplayed charts sit at that level. The data-lvlcount spans are kept in
// sync by live.js as charts are crossed off. Filtering itself is client-side
// (TAB_SCRIPT) keyed off each card's data-lvl.
function levelTabs(unplayed: UnplayedChart[]): string {
  if (!unplayed.length) return "";
  const counts = new Map<number, number>();
  for (const c of unplayed) counts.set(c.lvl, (counts.get(c.lvl) ?? 0) + 1);
  const levels = [...counts.keys()].sort((a, b) => a - b);
  const tab = (lvl: string, label: string, count: number, active: boolean) =>
    `<button type="button" class="lvltab${active ? " active" : ""}" ` +
    `data-lvl="${lvl}" aria-pressed="${active}">${label} ` +
    `<span class="tc" data-lvlcount="${lvl}">${count}</span></button>`;
  const all = tab("all", "All", unplayed.length, true);
  const rest = levels
    .map((l) => tab(String(l), `Lv ${l}`, counts.get(l)!, false))
    .join("");
  return `<div class="lvltabs" role="tablist">${all}${rest}</div>`;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(val: string | number): string {
  return String(val).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

function csvField(val: string | number): string {
  const s = String(val);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// Safely embed a JSON value inside an inline <script> tag. Escaping <, >, & is
// enough to prevent a </script> breakout; the only interpolated value here is
// the alphanumeric username, so no further escaping is needed.
function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

// Inline SVG favicon: a gold ♪ (the cover-art placeholder glyph) on the dark
// app background, matching the site palette. Inlined as a data URI so tabs get
// an icon with no extra asset or request. '#' is %23-escaped and the note is
// percent-encoded so the data URI is valid inside the href attribute.
const FAVICON =
  "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>" +
  "<rect width='32' height='32' rx='7' fill='%230d0f14'/>" +
  "<text x='16' y='24' font-size='24' text-anchor='middle' fill='%23ffd166' " +
  "font-family='system-ui,sans-serif'>%E2%99%AA</text></svg>";

function htmlPage(title: string, body: string, tail = ""): Response {
  const doc = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<link rel="icon" href="${FAVICON}" />
<link rel="stylesheet" href="/styles.css" />
</head>
<body><div class="wrap">${body}</div>${tail}</body>
</html>`;
  return new Response(doc, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// Per-request bootstrap for the cached live.js: the username plus a server-clock
// timestamp that seeds the "catch up on missed scores" watermark.
function liveTail(user: string): string {
  const config = { user, since: new Date().toISOString() };
  return `<script>window.__SMX=${jsonForScript(config)}</script>` +
    `<script src="/live.js" defer></script>`;
}

function statBlock(n: number | string, label: string, hl = false, key = ""): string {
  const attr = key ? ` data-stat="${key}"` : "";
  return `<div class="stat"><div class="n${hl ? " hl" : ""}"${attr}>${escapeHtml(n)}</div><div class="l">${escapeHtml(label)}</div></div>`;
}

// A "current / total" stat (e.g. 110/786) whose label carries the percentage,
// like "played (14%)". The numerator carries the data-stat key and the label's
// percent span carries data-pct + data-total so live.js can tick both the count
// and the percent while the fixed total holds.
function statFraction(n: number, total: number, label: string, key = ""): string {
  const attr = key ? ` data-stat="${key}"` : "";
  const pctAttr = key ? ` data-pct="${key}" data-total="${total}"` : "";
  return `<div class="stat"><div class="n"><span${attr}>${escapeHtml(n)}</span>` +
    `<span class="of">/${escapeHtml(total)}</span></div>` +
    `<div class="l">${escapeHtml(label)} ` +
    `<span class="pct"${pctAttr}>(${pctComplete(n, total)}%)</span></div></div>`;
}

// Renders one chart tile. Pass `score` for played-but-not-passed charts to show
// the player's best (failing) score as a second badge.
function chartCard(c: UnplayedChart, score?: number): string {
  const art = c.cover
    ? `<img loading="lazy" decoding="async" src="${escapeHtml(c.cover)}" alt="" />`
    : `<div class="noimg">♪</div>`;
  const scoreBadge = score != null
    ? `<span class="badge score">Best ${escapeHtml(formatScore(score))}</span>`
    : "";
  return `<li class="card" data-chart-id="${escapeHtml(c.id)}" data-lvl="${escapeHtml(c.lvl)}">${art}<div class="meta">` +
    `<span class="title">${escapeHtml(c.title)}</span>` +
    `<span class="artist">${escapeHtml(c.artist)}</span>` +
    `<span class="badge">${escapeHtml(c.diff)} · Lv ${escapeHtml(c.lvl)}</span>` +
    scoreBadge +
    `</div></li>`;
}

// Immediate submit feedback for the username form. A first lookup of an uncached
// user navigates to a page that can take a few seconds to build, and a bare GET
// form gives no sign anything happened — so swap the button label for a spinner
// the moment a valid submit fires, then let the navigation proceed. The "this
// may take a bit" note is delayed ~300ms so it never shows on a cache hit, which
// navigates away (cancelling the timer) before it fires.
const FORM_SCRIPT = `<script>
(function () {
  var form = document.querySelector(".formcard form");
  if (!form) return;
  var input = form.querySelector('input[name="user"]');
  var btn = form.querySelector("button");
  var label = btn.querySelector(".btn-label");
  var bspin = btn.querySelector(".btn-spinner");
  var status = document.querySelector(".formstatus");
  var submitted = false;
  var noteTimer;
  var KEY = "smx:lastUser";
  // Preserve the last submitted username across a Back navigation, in case they
  // returned to fix a typo. bfcache restores the field on its own; this also
  // covers a fresh reload, refilling from sessionStorage and selecting it so a
  // correction is one keystroke away.
  try {
    var saved = sessionStorage.getItem(KEY);
    if (saved && !input.value) { input.value = saved; input.select(); }
  } catch (e) {}
  form.addEventListener("submit", function (e) {
    // Block repeat submits (e.g. pressing Enter again in the input) once the
    // first valid submit is already navigating away.
    if (submitted) { e.preventDefault(); return; }
    var u = (input.value || "").trim();
    if (!u) return;
    try { sessionStorage.setItem(KEY, u); } catch (e2) {}
    submitted = true;
    btn.disabled = true;
    if (label) label.hidden = true;
    if (bspin) bspin.hidden = false;
    if (status) noteTimer = setTimeout(function () { status.hidden = false; }, 300);
  });
  // Back/forward bfcache restores this page mid-submit; reset it so it works again.
  window.addEventListener("pageshow", function (e) {
    if (e.persisted) {
      submitted = false;
      clearTimeout(noteTimer);
      btn.disabled = false;
      if (label) label.hidden = false;
      if (bspin) bspin.hidden = true;
      if (status) status.hidden = true;
    }
  });
})();
</script>`;

export function renderForm(): Response {
  const body = `<div class="formwrap"><div class="formcard">
  <h1>SMX Unplayed Songs</h1>
  <p>Enter a StepManiaX username to see which charts they haven't scored on yet.</p>
  <form method="get" action="">
    <input type="text" name="user" placeholder="username" autofocus required
      autocapitalize="off" autocomplete="off" spellcheck="false" />
    <button type="submit"><span class="btn-label">Go</span><span class="btn-spinner" hidden></span></button>
  </form>
  <div class="formstatus" hidden>this may take a bit…</div>
</div></div>`;
  return htmlPage("SMX Unplayed Songs", body, FORM_SCRIPT);
}

export function renderInvalidMode(user: string, msg: string): Response {
  return htmlPage(
    "Invalid mode",
    `<header class="page"><h1>Invalid mode</h1></header>` +
      `<div class="empty">${escapeHtml(msg)}<br /><br />` +
      `<a href="?user=${encodeURIComponent(user)}">← back</a></div>`,
  );
}

// Client-side level filtering for the mode page. Clicking a tab marks it active
// and toggles a hide class on every card whose data-lvl doesn't match ("All"
// shows everything). Pure DOM work — no refetch — so it's instant on long lists.
const TAB_SCRIPT = `<script>
(function () {
  var tabs = document.querySelector(".lvltabs");
  var grid = document.getElementById("unplayed-grid");
  if (!tabs || !grid) return;
  tabs.addEventListener("click", function (e) {
    var btn = e.target.closest(".lvltab");
    if (!btn) return;
    var lvl = btn.getAttribute("data-lvl");
    var btns = tabs.querySelectorAll(".lvltab");
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i] === btn;
      btns[i].classList.toggle("active", on);
      btns[i].setAttribute("aria-pressed", on ? "true" : "false");
    }
    // Only filter the unplayed grid; the failed section is separate. Re-query
    // each click so cards live.js has moved out are no longer affected.
    var cards = grid.querySelectorAll(":scope > .card");
    for (var j = 0; j < cards.length; j++) {
      var show = lvl === "all" || cards[j].getAttribute("data-lvl") === lvl;
      cards[j].classList.toggle("lvl-hide", !show);
    }
  });
})();
</script>`;

export function renderModePage(user: string, mode: Mode, result: ModeResult): Response {
  const { unplayed, failed, playedCount } = result;
  const enc = encodeURIComponent(user);
  const total = playedCount + unplayed.length;
  const passed = playedCount - failed.length;
  const crumbs = `<div class="crumbs"><a href="?user=${enc}">← all modes</a></div>`;
  const header = `<header class="page">${crumbs}` +
    `<h1>${diffIcon(mode, true)}<span class="u">${escapeHtml(user)}</span> · ${escapeHtml(mode)}</h1>` +
    `<div class="stats">` +
    statBlock(unplayed.length, "unplayed", true, "unplayed") +
    statFraction(playedCount, total, "played", "played") +
    // Only break out passed vs. played when some plays didn't pass.
    (failed.length ? statFraction(passed, total, "passed", "passed") : "") +
    `</div></header>`;

  const tabs = levelTabs(unplayed);

  const list = unplayed.length
    ? `<ul class="grid" id="unplayed-grid">${unplayed.map((c) => chartCard(c)).join("")}</ul>`
    : `<div class="empty">🎉 Every ${escapeHtml(mode)} chart has been played!</div>`;

  // Played but not passed: a secondary section below the unplayed list, each
  // card carrying the player's best failing score. live.js can create this
  // section on the fly when a chart is failed live (keep markup in sync).
  const failedSection = failed.length
    ? `<section class="failed-section">` +
      `<h2 class="section-title">Played but not passed ` +
      `<span class="section-count" data-failed-count>${failed.length}</span></h2>` +
      `<ul class="grid failed-grid">${failed.map((c) => chartCard(c, c.score)).join("")}</ul>` +
      `</section>`
    : "";

  const liveNote = `<div class="live-note"><span class="dot"></span>` +
    `Live — charts cross off as ${escapeHtml(user)} clears them</div>`;

  const links = `<div class="footer-links">` +
    `<a href="?user=${enc}&mode=${mode}&format=json">JSON</a>` +
    `<a href="?user=${enc}&mode=${mode}&format=csv">CSV</a>` +
    `</div>`;

  return htmlPage(
    `${user} · ${mode} · SMX unplayed`,
    header + tabs + list + failedSection + liveNote + links,
    liveTail(user) + TAB_SCRIPT,
  );
}

export function renderSummaryPage(user: string, result: SummaryResult): Response {
  const enc = encodeURIComponent(user);
  const header = `<header class="page">` +
    `<h1>SMX unplayed · <span class="u">${escapeHtml(user)}</span></h1>` +
    `<div class="stats">${statBlock(result.totalUnplayed, "total unplayed", true)}</div>` +
    `</header>`;

  const cards = VALID_MODES.map((m) => {
    const s = result.summary[m];
    const total = s.played_count + s.unplayed_count;
    const passed = s.played_count - s.failed_count;
    // Only add the passed line when some plays didn't pass, so it stays quiet
    // for modes where played already means passed.
    const passedRow = s.failed_count > 0
      ? `<div class="sub">${escapeHtml(passed)} / ${escapeHtml(total)} passed (${pctComplete(passed, total)}%)</div>`
      : "";
    return `<a class="modecard" href="?user=${enc}&mode=${m}">` +
      `<div class="modehd">${diffIcon(m)}<h2>${escapeHtml(m)}</h2></div>` +
      `<div class="big">${escapeHtml(s.unplayed_count)} <span class="unit">unplayed</span></div>` +
      `<div class="sub">${escapeHtml(s.played_count)} / ${escapeHtml(total)} played (${pctComplete(s.played_count, total)}%)</div>` +
      passedRow +
      `</a>`;
  }).join("");

  const links = `<div class="footer-links">` +
    `<a href="?user=${enc}&format=json">JSON</a>` +
    `<a href="?user=${enc}&format=json&details=true">JSON (with song lists)</a>` +
    `</div>`;

  return htmlPage(`${user} · SMX unplayed`, header + `<ul class="modes">${cards}</ul>` + links);
}

export function renderModeCsv(unplayed: UnplayedChart[]): Response {
  const columns = ["title", "artist", "lvl", "diff"] as const;
  const header = columns.join(",");
  const rows = unplayed.map((c) => columns.map((k) => csvField(c[k] ?? "")).join(","));
  return new Response([header, ...rows].join("\n"), {
    headers: {
      "Content-Type": "text/csv",
      // Allow cross-origin browser fetches, like the JSON endpoints (see main.ts).
      "Access-Control-Allow-Origin": "*",
    },
  });
}
