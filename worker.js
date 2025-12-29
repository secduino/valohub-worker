/**
 * ValoHub Store Check Worker
 * Render Background Worker
 *
 * - Bölge bazlı zamanlama
 * - False-positive koruması (hash + cooldown)
 * - Backend internal API entegrasyonu
 * - ntfy publish
 */

import express from "express";
import fetch from "node-fetch";
import cron from "node-cron";
import crypto from "crypto";

// ==================================================
// CONFIG
// ==================================================

const config = {
  backendUrl: process.env.BACKEND_URL,
  ntfyUrl: process.env.NTFY_URL,
  workerApiKey: process.env.WORKER_API_KEY,

  valorantApiUrl: "https://valorant-api.com/v1",

  regionSchedules: {
    TR: { start: 1, end: 3, interval: 5 },
    EU: { start: 1, end: 3, interval: 5 },
    NA: { start: 8, end: 10, interval: 5 },
    LATAM: { start: 7, end: 9, interval: 5 },
    BR: { start: 7, end: 9, interval: 5 },
    AP: { start: 12, end: 14, interval: 5 },
    KR: { start: 15, end: 17, interval: 5 },
  },

  cooldownMs: 24 * 60 * 60 * 1000,
};

// ==================================================
// STATE
// ==================================================

const regionState = {};
Object.keys(config.regionSchedules).forEach((r) => {
  regionState[r] = {
    lastHash: null,
    lastNotified: new Map(),
    lastCheck: null,
  };
});

// ==================================================
// HELPERS
// ==================================================

function utcHour() {
  return new Date().getUTCHours();
}

function inWindow(region) {
  const { start, end } = config.regionSchedules[region];
  const h = utcHour();
  return start <= end ? h >= start && h < end : h >= start || h < end;
}

function hashStore(items) {
  const ids = items.map((i) => i.skinId).sort().join(",");
  return crypto.createHash("md5").update(ids).digest("hex");
}

function canNotify(region, skinId) {
  const last = regionState[region].lastNotified.get(skinId);
  return !last || Date.now() - last > config.cooldownMs;
}

function markNotified(region, skinId) {
  regionState[region].lastNotified.set(skinId, Date.now());
}

// ==================================================
// BACKEND CALLS
// ==================================================

async function getActiveSkins(source) {
  const res = await fetch(
    `${config.backendUrl}/api/internal/active-skins?source=${source}`,
    { headers: { "x-api-key": config.workerApiKey } }
  );
  const data = await res.json();
  return data.skins || [];
}

async function getSubscriptions(skinId) {
  const res = await fetch(
    `${config.backendUrl}/api/internal/subscriptions/${skinId}`,
    { headers: { "x-api-key": config.workerApiKey } }
  );
  const data = await res.json();
  return data.subscriptions || [];
}

// ==================================================
// NTFY
// ==================================================

async function notify(topic, title, body) {
  await fetch(`${config.ntfyUrl}/${topic}`, {
    method: "POST",
    headers: {
      Title: title,
      Priority: "high",
      Tags: "video_game",
    },
    body,
  });
}

// ==================================================
// CORE LOGIC
// ==================================================

async function processRegion(region, storeItems, source = "store") {
  if (!inWindow(region)) return;

  const hash = hashStore(storeItems);
  const state = regionState[region];

  if (state.lastHash === hash) return;
  state.lastHash = hash;

  const activeSkins = await getActiveSkins(source);

  for (const item of storeItems) {
    const skinId = item.skinId;
    if (!skinId) continue;

    const match = activeSkins.find(
      (s) => s.skinId === skinId && s.regions.includes(region)
    );
    if (!match) continue;

    if (!canNotify(region, skinId)) continue;

    const subs = await getSubscriptions(skinId);
    const regionSubs = subs.filter(
      (s) => s.region === region && s.source === source
    );
    if (!regionSubs.length) continue;

    const topic = `valohub/${region}/${source}/${skinId}`;
    await notify(
      topic,
      "ValoHub",
      "🎯 Favori skinin mağazada!"
    );

    markNotified(region, skinId);
    console.log(`🔔 Notified ${topic}`);
  }

  state.lastCheck = new Date().toISOString();
}

// ==================================================
// CRONS
// ==================================================

Object.entries(config.regionSchedules).forEach(([region, cfg]) => {
  cron.schedule(`*/${cfg.interval} * * * *`, async () => {
    if (!inWindow(region)) return;

    console.log(`⏰ [${region}] window active`);
    // Gerçek store payload webhook ile gelir
  });
});

// ==================================================
// WEBHOOK + HEALTH (OPSİYONEL AMA YARARLI)
// ==================================================

const app = express();
app.use(express.json());

app.post("/webhook/store-update", async (req, res) => {
  const { region, source, items } = req.body;
  if (!region || !Array.isArray(items)) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  await processRegion(region.toUpperCase(), items, source || "store");
  res.json({ ok: true });
});

app.get("/health", (_, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    regions: Object.keys(regionState),
  });
});

// ==================================================
// START
// ==================================================

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log("🚀 ValoHub Worker started");
  console.log("📡 Backend:", config.backendUrl);
  console.log("🔔 NTFY:", config.ntfyUrl);
});
