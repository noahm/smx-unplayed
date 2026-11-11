// Live updates for the SMX Unplayed mode page. Served as a static asset and
// configured per-request via window.__SMX = { user, since } (see render.ts).
//
// Opens a WebSocket to the 573.no scores feed filtered to this user and reacts
// to scores the instant they land. A passing (cleared) score crosses the chart
// off as passed; a non-passing score moves the chart into the "played but not
// passed" section instead. Passing always wins, so a later pass upgrades a
// failed card. Only charts currently rendered (in the unplayed grid or the
// failed section) are touched, so replays of already-passed charts are ignored.
//
// Mobile-resilient: the socket usually dies when the phone locks/backgrounds
// (often mid-song), so on returning to the foreground we (1) REST-fetch any
// scores inserted while away and replay them, then (2) reconnect the socket.
// The "since" watermark is seeded from the server's clock and advanced by each
// score's created_at, so the catch-up query never depends on the phone's clock.
(function () {
  var CFG = window.__SMX;
  if (!CFG || !CFG.user) return;

  var REST = "https://api.smx.573.no/scores?q=";
  var WS_URL = "wss://api.smx.573.no/scores?q=" +
    encodeURIComponent(JSON.stringify({ "gamer.username": CFG.user }));
  // Per-chart transition already applied this session: "passed" | "failed".
  var seen = Object.create(null);
  var watermark = CFG.since;

  function setLive(on) {
    var note = document.querySelector(".live-note");
    if (note) note.classList.toggle("on", !!on);
  }

  function adjStat(key, delta) {
    var el = document.querySelector('[data-stat="' + key + '"]');
    if (!el) return;
    var v = parseInt(el.textContent, 10);
    if (!isNaN(v)) el.textContent = String(v + delta);
  }

  function decTabCount(el) {
    if (!el) return;
    var v = parseInt(el.textContent, 10);
    if (!isNaN(v)) el.textContent = String(Math.max(0, v - 1));
  }

  // A chart at `lvl` left the unplayed grid: decrement its level tab and "All".
  function adjTabCounts(lvl) {
    decTabCount(document.querySelector('[data-lvlcount="all"]'));
    if (lvl != null) decTabCount(document.querySelector('[data-lvlcount="' + lvl + '"]'));
  }

  // Percent string that never rounds up to 100 (mirrors pctComplete in
  // render.ts): only a genuinely complete set shows 100, otherwise a near-100
  // value shows one floored decimal, e.g. "99.8".
  function pctStr(n, total) {
    if (total <= 0) return "0";
    if (n >= total) return "100";
    var raw = (n / total) * 100;
    if (Math.round(raw) >= 100) return (Math.floor(raw * 10) / 10).toFixed(1);
    return String(Math.round(raw));
  }

  // Recompute a fraction stat's label percentage (e.g. "played (14%)") from its
  // live numerator and fixed total.
  function updatePctLabel(key) {
    var span = document.querySelector('[data-pct="' + key + '"]');
    if (!span) return;
    var numEl = document.querySelector('[data-stat="' + key + '"]');
    var total = parseInt(span.getAttribute("data-total"), 10);
    if (!numEl || isNaN(total)) return;
    var n = parseInt(numEl.textContent, 10);
    if (isNaN(n)) return;
    span.textContent = "(" + pctStr(n, total) + "%)";
  }

  function adjFailedCount(delta) {
    var el = document.querySelector("[data-failed-count]");
    if (!el) return;
    var v = parseInt(el.textContent, 10);
    if (!isNaN(v)) el.textContent = String(Math.max(0, v + delta));
  }

  function findCard(id) {
    return document.querySelector('.card[data-chart-id="' + id + '"]');
  }

  // Set (or replace) a card's live status tag.
  function setTag(card, text, cls) {
    var meta = card.querySelector(".meta");
    if (!meta) return;
    var tag = meta.querySelector(".live-tag");
    if (!tag) {
      tag = document.createElement("span");
      meta.appendChild(tag);
    }
    tag.className = cls;
    tag.textContent = text;
  }

  // Group a score into thousands (mirrors formatScore in render.ts).
  function fmtScore(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  function setScoreBadge(card, score) {
    if (score == null) return;
    var meta = card.querySelector(".meta");
    if (!meta) return;
    var b = meta.querySelector(".badge.score");
    if (!b) {
      b = document.createElement("span");
      b.className = "badge score";
      var diffBadge = meta.querySelector(".badge:not(.score)");
      if (diffBadge && diffBadge.nextSibling) meta.insertBefore(b, diffBadge.nextSibling);
      else meta.appendChild(b);
    }
    b.textContent = "Best " + fmtScore(score);
  }

  // The "played but not passed" grid, creating its section on first use so a
  // chart failed live still has somewhere to go. Markup matches render.ts.
  function failedGrid() {
    var sec = document.querySelector(".failed-section");
    if (!sec) {
      sec = document.createElement("section");
      sec.className = "failed-section";
      sec.innerHTML =
        '<h2 class="section-title">Played but not passed ' +
        '<span class="section-count" data-failed-count>0</span></h2>' +
        '<ul class="grid failed-grid"></ul>';
      var note = document.querySelector(".live-note");
      var wrap = document.querySelector(".wrap");
      if (note && note.parentNode) note.parentNode.insertBefore(sec, note);
      else if (wrap) wrap.appendChild(sec);
    }
    return sec.querySelector(".failed-grid");
  }

  // Is this card already in the played-but-not-passed bucket? True for cards
  // failed live this session (.failed) and for server-rendered failed cards
  // (plain cards living inside .failed-section).
  function inFailed(card) {
    return card.classList.contains("failed") || !!card.closest(".failed-section");
  }

  function markPassed(id) {
    if (seen[id] === "passed") return;
    var card = findCard(id);
    if (!card || card.classList.contains("passed")) return;
    var wasFailed = inFailed(card);
    seen[id] = "passed";
    card.classList.remove("failed");
    card.classList.add("passed", "justplayed");
    setTag(card, "✓ just passed", "live-tag");
    if (wasFailed) {
      // Already counted as played; it only moved from not-passed to passed.
      adjFailedCount(-1);
      adjStat("passed", 1);
      updatePctLabel("passed");
    } else {
      // Was an untouched unplayed-grid card.
      adjStat("unplayed", -1);
      adjStat("played", 1);
      adjStat("passed", 1);
      adjTabCounts(card.getAttribute("data-lvl"));
      updatePctLabel("played");
      updatePctLabel("passed");
    }
  }

  function markFailed(id, score) {
    if (seen[id] === "passed") return; // a pass already won; never downgrade
    var card = findCard(id);
    if (!card || card.classList.contains("passed")) return;
    if (inFailed(card)) {
      // Already in the failed bucket (live or server-rendered): it's counted as
      // played already, so just remember it and leave the counts alone.
      seen[id] = "failed";
      return;
    }
    // A fresh unplayed-grid card becomes played-but-not-passed.
    seen[id] = "failed";
    card.classList.remove("lvl-hide"); // ensure it shows once moved
    card.classList.add("failed", "justplayed");
    setTag(card, "✗ just failed", "live-tag fail");
    setScoreBadge(card, score);
    failedGrid().appendChild(card); // moves it out of the unplayed grid
    adjStat("unplayed", -1);
    adjStat("played", 1);
    adjTabCounts(card.getAttribute("data-lvl"));
    updatePctLabel("played");
    adjFailedCount(1);
  }

  function processScore(s) {
    if (!s || typeof s.song_chart_id !== "number") return;
    if (s.cleared) markPassed(s.song_chart_id);
    else markFailed(s.song_chart_id, s.score);
    if (s.created_at && Date.parse(s.created_at) > Date.parse(watermark)) {
      watermark = s.created_at;
    }
  }

  function handle(payload) {
    var items = Array.isArray(payload) ? payload : [payload];
    for (var i = 0; i < items.length; i++) processScore(items[i]);
  }

  // Replay any scores inserted since the watermark (i.e. while backgrounded).
  function catchUp() {
    var q = { "gamer.username": CFG.user, created_at: { gte: watermark }, _order: "asc" };
    fetch(REST + encodeURIComponent(JSON.stringify(q)), { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (list) { if (Array.isArray(list)) handle(list); })
      .catch(function () {});
  }

  var ws = null;
  var backoff = 1000;
  function schedule() {
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30000);
  }
  function connect() {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return; // CONNECTING/OPEN
    try { ws = new WebSocket(WS_URL); } catch (e) { schedule(); return; }
    ws.onopen = function () { backoff = 1000; setLive(true); };
    ws.onmessage = function (ev) {
      try { handle(JSON.parse(ev.data)); } catch (e) {}
    };
    ws.onclose = function () { setLive(false); schedule(); };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }

  // Foreground again (unlock / refocus / bfcache restore / network back):
  // catch up on missed scores, then make sure the socket is alive.
  function resume() {
    catchUp();
    connect();
  }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") resume();
  });
  window.addEventListener("pageshow", function (e) { if (e.persisted) resume(); });
  window.addEventListener("online", resume);

  connect();
})();
