const express = require("express");
const Redis = require("ioredis");
const { scrapeAll } = require("./scraper");
const channels = require("./channels.json");

const PORT = process.env.PORT || 7778;
const REDIS_URL =
  process.env.REDIS_URL ||
  "redis://redis.flash-card-io.svc.cluster.local:6379";
const REFRESH_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours
const REDIS_KEY = "iptv-scrapper:streams";

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

// In-memory cache
let streamsCache = [];

async function saveToRedis(streams) {
  if (!redis) return;
  try {
    await redis.set(REDIS_KEY, JSON.stringify(streams));
  } catch {}
}

async function loadFromRedis() {
  if (!redis) return null;
  try {
    await redis.connect();
    const json = await redis.get(REDIS_KEY);
    return json ? JSON.parse(json) : null;
  } catch {
    return null;
  }
}

async function refresh() {
  try {
    const streams = await scrapeAll(channels);
    if (streams.length > 0) {
      streamsCache = streams;
      await saveToRedis(streams);
      console.log(`Cached ${streams.length} streams`);
    } else {
      console.warn("Scraping returned 0 results, keeping previous cache");
    }
  } catch (err) {
    console.error("Refresh failed:", err.message);
  }
}

// ── Express API ──

const app = express();

app.get("/api/streams", (req, res) => {
  res.json(streamsCache);
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", channels: streamsCache.length });
});

// ── Startup ──

async function start() {
  // 1. Warm start from Redis
  const cached = await loadFromRedis();
  if (cached && cached.length > 0) {
    streamsCache = cached;
    console.log(`Warm start: ${cached.length} streams from Redis`);
  }

  // 2. Start server immediately
  app.listen(PORT, () => {
    console.log(`ip-tv-scrapper running at http://localhost:${PORT}`);
    console.log(`API: http://localhost:${PORT}/api/streams`);
  });

  // 3. First scrape in background
  refresh();

  // 4. Schedule periodic refresh
  setInterval(refresh, REFRESH_INTERVAL);
  console.log(`Scheduled refresh every ${REFRESH_INTERVAL / 3600000}h`);
}

start();
