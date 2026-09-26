const { scrapeMany } = require("./scraper");
const channels = require("./channels.json");

const PUSH_URL =
  process.env.PUSH_URL || "https://ip-tv.hatip.dev/scrapper/api/streams";
const REFRESH_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours

function parseExpiry(url) {
  try {
    const u = new URL(url);
    for (const key of ["ex", "e", "exp", "expires"]) {
      const val = u.searchParams.get(key);
      if (val) {
        const ts = parseInt(val);
        if (ts > 1e12) return ts;
        if (ts > 1e9) return ts * 1000;
      }
    }
  } catch {}
  return Date.now() + 4 * 60 * 60 * 1000;
}

async function scrapeAndPush() {
  console.log("Scraping...");
  const results = await scrapeMany(channels);

  const entries = results.map(({ channel, url }) => ({
    id: channel.id,
    name: channel.name,
    url,
    headers: {
      Referer: channel.referer,
      Origin: channel.referer.replace(/\/$/, ""),
    },
  }));

  if (entries.length === 0) {
    console.warn("No streams found, skipping push");
    return;
  }

  console.log(`Pushing ${entries.length} streams to ${PUSH_URL}...`);
  try {
    const res = await fetch(PUSH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entries),
    });
    const data = await res.json();
    console.log(`Push result:`, data);
  } catch (err) {
    console.error("Push failed:", err.message);
  }
}

async function main() {
  await scrapeAndPush();
  setInterval(scrapeAndPush, REFRESH_INTERVAL);
  console.log(`Scheduled: scrape & push every ${REFRESH_INTERVAL / 3600000}h`);
}

main();
