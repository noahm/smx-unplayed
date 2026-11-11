# SMX Unplayed

**<https://unplayed.smx.tools>**

Enter a [StepManiaX](https://stepmaniax.com/) username to see every chart that player has never scored on, mode by mode. Charts they've played but never passed get their own list with the best score so far. The mode page also updates live: once a score posts, its chart is crossed off as passed or moved to the not-passed list, with no reload. That makes it handy on a phone at the cab while working through a list.

The same data is available as JSON and CSV, plus a weekly leaderboard lookup made for stream widgets. Scores come from DesktopMan's [`api.smx.573.no`](https://github.com/DesktopMan/smx-api-docs), and the leaderboard comes from statmaniax.com. This project isn't affiliated with Step Revolution.

## API

Every endpoint is a `GET` to `https://unplayed.smx.tools/`, configured with query parameters. Nothing needs authentication. JSON and CSV responses send `Access-Control-Allow-Origin: *`, so browser code on any site can call them.

| Parameter | Values | |
|---|---|---|
| `user` | a StepManiaX username | required; case-insensitive |
| `mode` | `beginner`, `easy`, `hard`, `wild`, `dual`, `full` | leave it off to get a summary of all modes |
| `format` | `json`, `csv`, `html` | defaults to HTML for browsers and JSON for everything else |
| `details` | `true` | all-modes JSON only; includes every mode's chart lists |

Each mode includes its "+" difficulties, so `easy` covers easy and easy+. Only charts currently enabled in the game are counted.

### All-modes summary

`/?user=NAME&format=json`

```json
{
  "user": "NAME",
  "total_unplayed": 2164,
  "modes": {
    "beginner": { "played_count": 7, "unplayed_count": 554, "failed_count": 0 },
    "easy": { "...": "..." }
  }
}
```

`failed_count` counts charts played but never passed, and it's part of `played_count`. Add `&details=true` to expand each entry under `modes` into the full single-mode payload below, so one request returns every mode's lists.

### One mode

`/?user=NAME&mode=wild&format=json`

```json
{
  "user": "NAME",
  "mode": "wild",
  "played_count": 561,
  "unplayed_count": 0,
  "failed_count": 1,
  "unplayed": [],
  "failed": [
    {
      "title": "MAX428",
      "artist": "Omega",
      "lvl": 27,
      "diff": "wild",
      "score": 63469,
      "jacket": "https://data.stepmaniax.com/uploads/songs/Max428/cover@256x256.jpg"
    }
  ]
}
```

`unplayed` entries have the same fields, minus `score`. `diff` is the display name, e.g. `hard+`, and `jacket` is `null` when a song has no cover art.

`&format=csv` returns just the unplayed list, with columns `title,artist,lvl,diff`.

### Weekly leaderboard

`/?board=weekly&user=NAME[&context=N]`

Returns the player's place on this week's official rank-points board, plus `N` places above and below them (default 2, max 10). The response is always JSON, and it's built to be polled from a stream overlay.

```json
{
  "user": "NAME",
  "period_start": "2026-11-10T00:00:00.000Z",
  "period_end": "2026-11-17T00:00:00.000Z",
  "rank": 42,
  "points": 123456,
  "total_players": 218,
  "context": [{ "rank": 41, "username": "SOMEONE", "points": 125000 }, "..."]
}
```

Ties share a rank ("1224" ranking). If the player hasn't scored this week, `rank` is `null`, `points` is `0`, and `context` shows the top of the board instead.

### Errors

A bad request, such as a missing `user` or an unknown `mode`, gets HTTP 400 with `{ "error": "..." }`.

## Development

This is a Cloudflare Worker. Scores and chart data are cached in KV, and two Cron Triggers keep the shared chart data warm and check that the leaderboard source is still up.

```sh
npm install
npm run dev        # local server via wrangler
npm run typecheck
npm run deploy
```

See [CLAUDE.md](CLAUDE.md) for how the code is organized and how the caching works. [API_DOCS.md](API_DOCS.md) is a copy of the upstream 573.no API docs.
