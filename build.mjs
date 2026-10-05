// Fetches every enabled RSS source and writes signal.json, the feed khalidsaidi.com reads.
// Ported from khalidsaidi-com/functions/src/ingest/rss.ts + score.ts (same ids, scoring and tags);
// The previous signal.json stands in for the Firestore newsItems collection, so an item
// survives while it is in the top or latest list and younger than KEEP_DAYS.
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import Parser from "rss-parser"

const OUT = "signal.json"
const KEEP_DAYS = 30
const LIST_MAX = 200

const parser = new Parser()
const USER_AGENT = "Mozilla/5.0 (compatible; khalidsaidi.com signal feed; +https://khalidsaidi.com/signal)"

// Fetch the feed ourselves: a hard per-source timeout, and deepmind.google serves gzip bytes
// without a Content-Encoding header, which rss-parser's parseURL cannot read.
async function fetchFeed(url, attempt = 1) {
  const retry = async () => {
    await new Promise((resolve) => setTimeout(resolve, attempt * 5000))
    return fetchFeed(url, attempt + 1)
  }
  let response
  try {
    response = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(30000) })
  } catch (error) {
    if (attempt < 3) return retry()
    throw error
  }
  if (!response.ok && attempt < 3 && (response.status === 419 || response.status === 429 || response.status >= 500)) {
    return retry()
  }
  if (!response.ok) throw new Error(`Status code ${response.status}`)
  let body = Buffer.from(await response.arrayBuffer())
  if (body[0] === 0x1f && body[1] === 0x8b) body = gunzipSync(body)
  return parser.parseString(body.toString("utf8").replace(/^\uFEFF/, ""))
}

const KEYWORD_TAGS = [
  ["firebase", "firebase"],
  ["observability", "observability"],
  ["status", "status"],
  ["monitoring", "monitoring"],
  ["agent", "agent"],
  ["llm", "llm"],
  ["openai", "openai"],
  ["anthropic", "anthropic"],
  ["gcp", "gcp"],
  ["kubernetes", "kubernetes"],
]

function computeScore(publishedAt, sourceWeight = 1) {
  const hoursSince = Math.max(0, (Date.now() - publishedAt.getTime()) / 36e5)
  const recencyBoost = Math.max(0, 500 - hoursSince * 10)
  return Math.round(sourceWeight * 1000 + recencyBoost)
}

function deriveTags(title, url, sourceTags) {
  const tags = new Set(sourceTags.map((tag) => tag.toLowerCase()))
  const haystack = `${title} ${url}`.toLowerCase()
  for (const [keyword, tag] of KEYWORD_TAGS) {
    if (haystack.includes(keyword)) tags.add(tag)
  }
  return Array.from(tags)
}

function normalizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl.trim())
    url.hash = ""
    url.hostname = url.hostname.toLowerCase()
    if (url.hostname.startsWith("www.")) url.hostname = url.hostname.slice(4)
    for (const key of Array.from(url.searchParams.keys())) {
      if (key.toLowerCase().startsWith("utm_")) url.searchParams.delete(key)
    }
    let normalized = url.toString()
    if (normalized.endsWith("/")) normalized = normalized.slice(0, -1)
    return normalized
  } catch {
    return null
  }
}

function parsePublishedAt(isoDate, pubDate) {
  const raw = isoDate || pubDate
  if (!raw) return null
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

const sources = JSON.parse(readFileSync("sources.json", "utf8")).filter((source) => source.enabled)
const previous = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {}
const items = new Map()
for (const item of [...(previous.latest ?? []), ...(previous.top ?? []), ...(previous.pinned ?? [])]) {
  items.set(item.id, item)
}

const ingestedAt = new Date()
const report = []
await Promise.all(
  sources.map(async (source) => {
    try {
      const feed = await fetchFeed(source.url)
      let count = 0
      for (const entry of feed.items ?? []) {
        const rawUrl = entry.link || entry.guid || entry.id
        const url = rawUrl && normalizeUrl(rawUrl)
        if (!url) continue
        const id = createHash("sha256").update(url).digest("hex")
        const title = entry.title?.trim() || "Untitled"
        const publishedAt = parsePublishedAt(entry.isoDate, entry.pubDate) ?? ingestedAt
        const existing = items.get(id)
        items.set(id, {
          id,
          title,
          url,
          ...(url !== rawUrl ? { canonicalUrl: rawUrl } : {}),
          domain: new URL(url).hostname.replace(/^www\./, ""),
          sourceId: source.id,
          sourceName: source.name,
          publishedAt: publishedAt.toISOString(),
          ingestedAt: ingestedAt.toISOString(),
          tags: deriveTags(title, url, source.tags),
          status: existing?.status === "pinned" ? "pinned" : "active",
          ...(existing?.note ? { note: existing.note } : {}),
        })
        count += 1
      }
      report.push(`ok    ${source.id}: ${count}`)
    } catch (error) {
      report.push(`FAIL  ${source.id}: ${error.message}`)
    }
  }),
)

const weights = new Map(sources.map((source) => [source.id, source.weight]))
const cutoff = Date.now() - KEEP_DAYS * 864e5
const kept = [...items.values()]
  .filter((item) => item.status === "pinned" || Date.parse(item.publishedAt) >= cutoff)
  .map((item) => ({ ...item, score: computeScore(new Date(item.publishedAt), weights.get(item.sourceId) ?? 1) }))
  .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))

const active = kept.filter((item) => item.status === "active")
const signal = {
  generatedAt: ingestedAt.toISOString(),
  pinned: kept.filter((item) => item.status === "pinned").sort((a, b) => b.score - a.score),
  top: [...active].sort((a, b) => b.score - a.score).slice(0, LIST_MAX),
  latest: active.slice(0, LIST_MAX),
}
writeFileSync(OUT, JSON.stringify(signal, null, 1) + "\n")

console.log(report.sort().join("\n"))
console.log(`${kept.length} items kept, ${signal.top.length} top, ${signal.latest.length} latest`)
if (report.every((line) => line.startsWith("FAIL"))) process.exit(1)
