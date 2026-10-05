# signal-feed

The news feed behind [khalidsaidi.com/signal](https://khalidsaidi.com/signal).

Every 30 minutes a GitHub Actions job reads the RSS feeds in [`sources.json`](sources.json),
scores each item (source weight + recency) and commits [`signal.json`](signal.json).
GitHub Pages serves it at <https://khalidsaidi.github.io/signal-feed/signal.json>, and the
site fetches it from the browser. No server, no database, nothing to pay for.

- Run it locally: `npm ci && node build.mjs`
- Add or remove a feed: edit `sources.json` (`weight` ~0.8–1.3; `enabled: false` to pause)
- Pin an item: set its `"status": "pinned"` in `signal.json`; the build keeps it
- Items are kept for 30 days; `top` and `latest` hold up to 200 each
