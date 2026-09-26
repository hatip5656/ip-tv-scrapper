const express = require("express");
const Redis = require("ioredis");
const { scrapeChannel, scrapeMany } = require("./scraper");
const channels = require("./channels.json");

const PORT = process.env.PORT || 7778;
const REDIS_URL =
  process.env.REDIS_URL ||
  "redis://redis.flash-card-io.svc.cluster.local:6379";
const REDIS_KEY = "iptv-scrapper:streams";
const CHECK_INTERVAL = 15 * 60 * 1000; // check every 15 min
const EXPIRY_BUFFER = 30 * 60 * 1000; // refresh 30 min before expiry

// Redis
let redis = null;
try {
  redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 1,
    connectTimeout: 5000,
    lazyConnect: true,
  });
  redis.on("error", () => {});
} catch {
  console.warn("Redis not available");
}

// ── Stream cache: id → { id, name, url, headers, expiresAt } ──

const streamCache = new Map();

function parseExpiry(url) {
  try {
    const u = new URL(url);
    // Try common token expiry params: ex, e, exp, expires
    for (const key of ["ex", "e", "exp", "expires"]) {
      const val = u.searchParams.get(key);
      if (val) {
        const ts = parseInt(val);
        if (ts > 1e12) return ts; // milliseconds
        if (ts > 1e9) return ts * 1000; // seconds → ms
      }
    }
  } catch {}
  // Default: assume 4 hour lifetime if no expiry found
  return Date.now() + 4 * 60 * 60 * 1000;
}

function buildEntry(channel, url) {
  return {
    id: channel.id,
    name: channel.name,
    url,
    headers: {
      Referer: channel.referer,
      Origin: channel.referer.replace(/\/$/, ""),
    },
    expiresAt: parseExpiry(url),
  };
}

async function saveToRedis() {
  if (!redis) return;
  try {
    const data = [...streamCache.values()];
    await redis.set(REDIS_KEY, JSON.stringify(data));
  } catch {}
}

async function loadFromRedis() {
  if (!redis) return;
  try {
    await redis.connect();
    const json = await redis.get(REDIS_KEY);
    if (!json) return;
    const data = JSON.parse(json);
    for (const entry of data) {
      // Only load entries that haven't expired
      if (entry.expiresAt > Date.now()) {
        streamCache.set(entry.id, entry);
      }
    }
    console.log(`Warm start: ${streamCache.size} streams from Redis`);
  } catch {}
}

// ── Refresh logic ──

let refreshing = false;

async function fullRefresh() {
  if (refreshing) return;
  refreshing = true;

  try {
    const results = await scrapeMany(channels);
    for (const { channel, url } of results) {
      streamCache.set(channel.id, buildEntry(channel, url));
    }
    await saveToRedis();
    console.log(`Full refresh: ${streamCache.size} channels cached`);
  } catch (err) {
    console.error("Full refresh failed:", err.message);
  }

  refreshing = false;
}

async function partialRefresh() {
  if (refreshing) return;

  const now = Date.now();
  const expiring = channels.filter((ch) => {
    const entry = streamCache.get(ch.id);
    if (!entry) return true; // never scraped
    return entry.expiresAt - now < EXPIRY_BUFFER; // expires within 30 min
  });

  if (expiring.length === 0) return;

  refreshing = true;
  console.log(`Partial refresh: ${expiring.length} channels expiring soon`);

  try {
    const results = await scrapeMany(expiring);
    for (const { channel, url } of results) {
      streamCache.set(channel.id, buildEntry(channel, url));
    }
    await saveToRedis();
  } catch (err) {
    console.error("Partial refresh failed:", err.message);
  }

  refreshing = false;
}

// ── Express API ──

const app = express();

app.get("/api/streams", (req, res) => {
  const results = [...streamCache.values()].map(
    ({ id, name, url, headers }) => ({ id, name, url, headers })
  );
  res.json(results);
});

app.get("/api/streams/:id", (req, res) => {
  const entry = streamCache.get(req.params.id);
  if (!entry) return res.status(404).json({ error: "not found" });
  const { id, name, url, headers } = entry;
  res.json({ id, name, url, headers });
});

// Push endpoint — local scraper sends fresh URLs here
app.use(express.json());
app.post("/api/streams", (req, res) => {
  const entries = req.body;
  if (!Array.isArray(entries)) {
    return res.status(400).json({ error: "expected array" });
  }
  let updated = 0;
  for (const entry of entries) {
    if (!entry.id || !entry.url) continue;
    const channel = channels.find((ch) => ch.id === entry.id) || {
      id: entry.id,
      name: entry.name || entry.id,
      referer: entry.headers?.Referer || "",
    };
    streamCache.set(entry.id, buildEntry(channel, entry.url));
    updated++;
  }
  saveToRedis();
  console.log(`Push received: ${updated} streams updated`);
  res.json({ updated });
});

app.get("/health", (req, res) => {
  const entries = [...streamCache.values()];
  const expired = entries.filter((e) => e.expiresAt < Date.now()).length;
  res.json({
    status: "ok",
    channels: entries.length,
    expired,
    active: entries.length - expired,
  });
});

// ── Startup ──

async function start() {
  await loadFromRedis();

  app.listen(PORT, () => {
    console.log(`ip-tv-scrapper running at http://localhost:${PORT}`);
  });

  // Only scrape if not in passive mode (VPS can't reach Turkish sites)
  if (process.env.PASSIVE !== "true") {
    fullRefresh();
    setInterval(partialRefresh, CHECK_INTERVAL);
    console.log("Scheduled: partial refresh every 15min");
  } else {
    console.log("Passive mode: waiting for push from local scraper");
  }
}

start();
