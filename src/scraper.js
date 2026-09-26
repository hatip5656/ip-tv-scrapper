const { chromium } = require("playwright");

const SCRAPE_TIMEOUT = 20000;
const CONCURRENCY = 5; // parallel browser tabs
const M3U8_PATTERN = /\.m3u8/;

async function scrapeChannel(channel, browser) {
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  // Block heavy resources — we only need network requests
  await page.route(/\.(png|jpg|jpeg|gif|svg|woff2?|ttf|css)(\?|$)/i, (route) =>
    route.abort()
  );

  let streamUrl = null;

  page.on("response", (response) => {
    if (streamUrl) return;
    const url = response.url();
    if (M3U8_PATTERN.test(url)) {
      streamUrl = url;
    }
  });

  try {
    await page.goto(channel.page, {
      waitUntil: "domcontentloaded",
      timeout: SCRAPE_TIMEOUT,
    });

    // Try clicking play button
    try {
      const playButton = page.locator(
        'button:has-text("Canlı"), button:has-text("Oynat"), button:has-text("Play"), .play-button, .vjs-big-play-button'
      );
      if (await playButton.isVisible({ timeout: 2000 })) {
        await playButton.click();
      }
    } catch {}

    // Wait for the stream URL
    const start = Date.now();
    while (!streamUrl && Date.now() - start < SCRAPE_TIMEOUT) {
      await page.waitForTimeout(500);
    }
  } catch (err) {
    // page load failure — streamUrl stays null
  } finally {
    await context.close();
  }

  return streamUrl;
}

async function scrapeAll(channels) {
  console.log(`Scraping ${channels.length} channels (concurrency: ${CONCURRENCY})...`);
  const start = Date.now();

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });

  const results = [];
  const queue = [...channels];

  // Process in parallel batches
  async function worker() {
    while (queue.length > 0) {
      const channel = queue.shift();
      const t = Date.now();
      const url = await scrapeChannel(channel, browser);
      const elapsed = ((Date.now() - t) / 1000).toFixed(1);

      if (url) {
        console.log(`  ✓ ${channel.name} (${elapsed}s)`);
        results.push({
          id: channel.id,
          name: channel.name,
          url,
          headers: {
            Referer: channel.referer,
            Origin: channel.referer.replace(/\/$/, ""),
          },
        });
      } else {
        console.warn(`  ✗ ${channel.name} (${elapsed}s)`);
      }
    }
  }

  // Spawn workers
  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);

  await browser.close();

  const totalElapsed = ((Date.now() - start) / 1000).toFixed(0);
  console.log(
    `Scraping done: ${results.length}/${channels.length} found in ${totalElapsed}s`
  );
  return results;
}

module.exports = { scrapeAll };
