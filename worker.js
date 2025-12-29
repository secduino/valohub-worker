/**
 * ValoHub Store Check Worker
 * Render Background Worker olarak çalışır
 * 
 * ÖNEMLİ: BÖLGE BAZLI ZAMANLAMA
 * - Her bölge kendi zaman penceresinde kontrol edilir
 * - Tek saatten bildirim gönderme YOK
 * - False positive koruması aktif
 */

const express = require('express');
const fetch = require('node-fetch');
const cron = require('node-cron');
const crypto = require('crypto');

// ============================================
// CONFIG
// ============================================

const config = {
  backendUrl: process.env.BACKEND_URL || 'https://valohub-backend.onrender.com',
  ntfyUrl: process.env.NTFY_URL || 'https://valohub-ntfy.onrender.com',
  workerApiKey: process.env.WORKER_API_KEY || 'dev-worker-key',
  ntfyAuthToken: process.env.NTFY_AUTH_TOKEN || '',
  valorantApiUrl: 'https://valorant-api.com/v1',
  
  // ============================================
  // BÖLGE BAZLI MAĞAZA GÜNCELLEME PENCERELERİ (UTC)
  // ============================================
  regionSchedules: {
    'TR': {
      // TR/EU: 01:00 - 03:00 UTC arası
      startHour: 1,
      endHour: 3,
      checkInterval: 5, // dakika
      timezone: 'Europe/Istanbul'
    },
    'EU': {
      startHour: 1,
      endHour: 3,
      checkInterval: 5,
      timezone: 'Europe/London'
    },
    'NA': {
      // NA: 08:00 - 10:00 UTC arası
      startHour: 8,
      endHour: 10,
      checkInterval: 5,
      timezone: 'America/New_York'
    },
    'LATAM': {
      // LATAM: 07:00 - 09:00 UTC arası
      startHour: 7,
      endHour: 9,
      checkInterval: 5,
      timezone: 'America/Sao_Paulo'
    },
    'BR': {
      startHour: 7,
      endHour: 9,
      checkInterval: 5,
      timezone: 'America/Sao_Paulo'
    },
    'AP': {
      // APAC: 12:00 - 14:00 UTC arası
      startHour: 12,
      endHour: 14,
      checkInterval: 5,
      timezone: 'Asia/Tokyo'
    },
    'KR': {
      // KR: 15:00 - 17:00 UTC arası
      startHour: 15,
      endHour: 17,
      checkInterval: 5,
      timezone: 'Asia/Seoul'
    }
  },
  
  messages: {
    store: {
      tr: '🎯 Favori skinin bugün mağazada!',
      en: '🎯 Your favorite skin is in the store today!'
    },
    night: {
      tr: '🌙 Gece pazarında istediğin skin var!',
      en: '🌙 Your wishlist skin is in Night Market!'
    },
    bundle: {
      tr: '📦 Aradığın skin yeni pakette!',
      en: '📦 Your desired skin is in a new bundle!'
    }
  }
};

// ============================================
// BÖLGE DURUMU (STATE)
// ============================================

const regionState = {
  // Her bölge için son kontrol zamanı ve store hash'i
  // Format: { lastCheck, storeHash, lastNotifiedSkins: Map<skinId, timestamp> }
};

// Bölge state'ini başlat
Object.keys(config.regionSchedules).forEach(region => {
  regionState[region] = {
    lastCheck: null,
    storeHash: null,
    isInWindow: false,
    lastNotifiedSkins: new Map(), // skinId -> timestamp (24 saat cooldown için)
    checkCount: 0
  };
});

// ============================================
// SKIN CACHE
// ============================================

let skinCache = null;
let skinCacheTime = null;
const SKIN_CACHE_DURATION = 60 * 60 * 1000; // 1 saat

async function getAllSkins() {
  if (skinCache && skinCacheTime && (Date.now() - skinCacheTime) < SKIN_CACHE_DURATION) {
    return skinCache;
  }
  
  try {
    const response = await fetch(`${config.valorantApiUrl}/weapons/skins`);
    const data = await response.json();
    
    if (data.status === 200 && data.data) {
      skinCache = new Map();
      data.data.forEach(skin => {
        if (skin.uuid) {
          skinCache.set(skin.uuid, {
            name: skin.displayName,
            icon: skin.displayIcon
          });
        }
        if (skin.levels) {
          skin.levels.forEach(level => {
            if (level.uuid) {
              skinCache.set(level.uuid, {
                name: level.displayName || skin.displayName,
                icon: level.displayIcon || skin.displayIcon
              });
            }
          });
        }
      });
      skinCacheTime = Date.now();
      console.log(`✅ Skin cache yüklendi: ${skinCache.size} skin`);
    }
  } catch (error) {
    console.error('❌ Skin cache yükleme hatası:', error.message);
  }
  
  return skinCache;
}

function getSkinName(skinId) {
  if (!skinCache) return skinId;
  const skin = skinCache.get(skinId);
  return skin ? skin.name : skinId;
}

// ============================================
// BÖLGE ZAMAN PENCERESİ KONTROLÜ
// ============================================

function isInRegionWindow(region) {
  const schedule = config.regionSchedules[region];
  if (!schedule) return false;
  
  const now = new Date();
  const utcHour = now.getUTCHours();
  
  // Zaman penceresi içinde mi?
  if (schedule.startHour <= schedule.endHour) {
    return utcHour >= schedule.startHour && utcHour < schedule.endHour;
  } else {
    // Gece yarısını geçen pencere (örn: 23:00 - 02:00)
    return utcHour >= schedule.startHour || utcHour < schedule.endHour;
  }
}

function getActiveRegions() {
  return Object.keys(config.regionSchedules).filter(region => isInRegionWindow(region));
}

// ============================================
// STORE HASH (DEĞİŞİKLİK TESPİTİ)
// ============================================

function generateStoreHash(items) {
  const sortedIds = items
    .map(item => item.skinId || item.offerId)
    .filter(Boolean)
    .sort()
    .join(',');
  
  return crypto.createHash('md5').update(sortedIds).digest('hex');
}

function hasStoreChanged(region, newHash) {
  const state = regionState[region];
  if (!state.storeHash) {
    state.storeHash = newHash;
    return true; // İlk kontrol, değişmiş say
  }
  
  if (state.storeHash !== newHash) {
    state.storeHash = newHash;
    return true;
  }
  
  return false;
}

// ============================================
// 24 SAAT COOLDOWN KONTROLÜ
// ============================================

const NOTIFICATION_COOLDOWN = 24 * 60 * 60 * 1000; // 24 saat

function canNotifyForSkin(region, skinId) {
  const state = regionState[region];
  const lastNotified = state.lastNotifiedSkins.get(skinId);
  
  if (!lastNotified) return true;
  
  const elapsed = Date.now() - lastNotified;
  return elapsed >= NOTIFICATION_COOLDOWN;
}

function markSkinNotified(region, skinId) {
  const state = regionState[region];
  state.lastNotifiedSkins.set(skinId, Date.now());
  
  // Eski kayıtları temizle (48 saatten eski)
  const cutoff = Date.now() - (48 * 60 * 60 * 1000);
  for (const [id, timestamp] of state.lastNotifiedSkins) {
    if (timestamp < cutoff) {
      state.lastNotifiedSkins.delete(id);
    }
  }
}

// ============================================
// BACKEND API CALLS
// ============================================

async function getActiveSkins(source = 'store') {
  try {
    const response = await fetch(
      `${config.backendUrl}/api/internal/active-skins?source=${source}`,
      {
        headers: { 'X-API-Key': config.workerApiKey }
      }
    );
    const data = await response.json();
    return data.skins || [];
  } catch (error) {
    console.error(`❌ Active skins alınamadı (${source}):`, error.message);
    return [];
  }
}

async function getSubscriptionsForSkin(skinId) {
  try {
    const response = await fetch(
      `${config.backendUrl}/api/internal/subscriptions/${skinId}`,
      {
        headers: { 'X-API-Key': config.workerApiKey }
      }
    );
    const data = await response.json();
    return data.subscriptions || [];
  } catch (error) {
    console.error(`❌ Subscription alınamadı (${skinId}):`, error.message);
    return [];
  }
}

// ============================================
// NTFY NOTIFICATION
// ============================================

async function sendNtfyNotification(topic, message, skinName, icon = null) {
  try {
    const headers = {
      'Content-Type': 'text/plain',
      'Title': `ValoHub: ${skinName}`,
      'Tags': 'video_game,gift',
      'Priority': 'high'
    };
    
    if (icon) headers['Icon'] = icon;
    if (config.ntfyAuthToken) headers['Authorization'] = `Bearer ${config.ntfyAuthToken}`;
    
    const response = await fetch(`${config.ntfyUrl}/${topic}`, {
      method: 'POST',
      headers,
      body: message
    });
    
    if (response.ok) {
      console.log(`✅ Bildirim gönderildi: ${topic}`);
      return true;
    } else {
      console.error(`❌ Bildirim hatası: ${response.status} - ${topic}`);
      return false;
    }
  } catch (error) {
    console.error(`❌ Ntfy hatası (${topic}):`, error.message);
    return false;
  }
}

// ============================================
// BÖLGE BAZLI STORE İŞLEME
// ============================================

async function processRegionStore(region, storeItems, source = 'store') {
  const state = regionState[region];
  
  // Zaman penceresi kontrolü
  if (!isInRegionWindow(region)) {
    console.log(`⏰ ${region} zaman penceresi dışında, atlanıyor`);
    return { skipped: true, reason: 'outside_window' };
  }
  
  // Store hash kontrolü
  const newHash = generateStoreHash(storeItems);
  if (!hasStoreChanged(region, newHash)) {
    console.log(`🔄 ${region} store değişmemiş, atlanıyor`);
    return { skipped: true, reason: 'no_change' };
  }
  
  console.log(`🔍 ${region} store değişti, kontrol ediliyor...`);
  
  const activeSkins = await getActiveSkins(source);
  const notificationsSent = [];
  const skippedCooldown = [];
  
  for (const item of storeItems) {
    const skinId = item.skinId || item.offerId;
    if (!skinId) continue;
    
    // Bu skin'i bekleyen var mı?
    const matchingSkin = activeSkins.find(s => s.skinId === skinId);
    if (!matchingSkin) continue;
    
    // Bu bölgede bekleyen var mı?
    if (!matchingSkin.regions.includes(region)) continue;
    
    // 24 saat cooldown kontrolü
    if (!canNotifyForSkin(region, skinId)) {
      console.log(`⏳ ${skinId} için cooldown aktif, atlanıyor`);
      skippedCooldown.push(skinId);
      continue;
    }
    
    // Subscription'ları al
    const subscriptions = await getSubscriptionsForSkin(skinId);
    const regionSubs = subscriptions.filter(
      sub => sub.region === region && sub.source === source
    );
    
    if (regionSubs.length === 0) continue;
    
    // Bildirim gönder
    const topic = `valohub/${region}/${source}/${skinId}`;
    const skinName = getSkinName(skinId);
    const message = config.messages[source]?.tr || config.messages.store.tr;
    
    const sent = await sendNtfyNotification(topic, message, skinName, item.icon);
    
    if (sent) {
      markSkinNotified(region, skinId);
      notificationsSent.push({
        topic,
        skinId,
        skinName,
        subscriberCount: regionSubs.length
      });
    }
  }
  
  // State güncelle
  state.lastCheck = new Date().toISOString();
  state.checkCount++;
  
  return {
    skipped: false,
    region,
    source,
    processed: storeItems.length,
    notificationsSent: notificationsSent.length,
    skippedCooldown: skippedCooldown.length,
    notifications: notificationsSent
  };
}

// ============================================
// EXPRESS SERVER
// ============================================

const app = express();
app.use(express.json());

// Client'tan store verisi al (bölge bazlı)
app.post('/webhook/store-update', async (req, res) => {
  const { region, source, items, timestamp } = req.body;
  
  if (!region || !items || !Array.isArray(items)) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  
  const normalizedRegion = region.toUpperCase();
  
  // Bölge geçerli mi?
  if (!config.regionSchedules[normalizedRegion]) {
    return res.status(400).json({ 
      error: 'Invalid region',
      validRegions: Object.keys(config.regionSchedules)
    });
  }
  
  console.log(`📥 Store update: ${normalizedRegion} - ${source} - ${items.length} item`);
  
  const result = await processRegionStore(
    normalizedRegion,
    items,
    source || 'store'
  );
  
  res.json({
    success: true,
    ...result
  });
});

// Health check (detaylı)
app.get('/health', (req, res) => {
  const activeRegions = getActiveRegions();
  const regionStatus = {};
  
  Object.keys(regionState).forEach(region => {
    const state = regionState[region];
    const schedule = config.regionSchedules[region];
    
    regionStatus[region] = {
      isInWindow: isInRegionWindow(region),
      windowUTC: `${schedule.startHour}:00 - ${schedule.endHour}:00`,
      lastCheck: state.lastCheck,
      checkCount: state.checkCount,
      pendingNotifications: state.lastNotifiedSkins.size
    };
  });
  
  res.json({
    status: 'ok',
    type: 'worker',
    timestamp: new Date().toISOString(),
    skinCacheSize: skinCache?.size || 0,
    activeRegions,
    regionStatus,
    uptime: process.uptime()
  });
});

// Bölge durumunu getir
app.get('/status/:region', (req, res) => {
  const region = req.params.region.toUpperCase();
  const state = regionState[region];
  const schedule = config.regionSchedules[region];
  
  if (!state || !schedule) {
    return res.status(404).json({ error: 'Region not found' });
  }
  
  res.json({
    region,
    isInWindow: isInRegionWindow(region),
    schedule: {
      startHour: schedule.startHour,
      endHour: schedule.endHour,
      checkInterval: schedule.checkInterval,
      timezone: schedule.timezone
    },
    state: {
      lastCheck: state.lastCheck,
      storeHash: state.storeHash,
      checkCount: state.checkCount,
      cooldownSkins: Array.from(state.lastNotifiedSkins.entries()).map(([id, ts]) => ({
        skinId: id,
        notifiedAt: new Date(ts).toISOString(),
        cooldownEnds: new Date(ts + NOTIFICATION_COOLDOWN).toISOString()
      }))
    }
  });
});

// Manuel bölge kontrolü tetikle (test için)
app.post('/trigger/:region', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== config.workerApiKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const region = req.params.region.toUpperCase();
  const { items, source } = req.body;
  
  if (!items || !Array.isArray(items)) {
    return res.status(400).json({ error: 'items array required' });
  }
  
  // Zaman penceresi kontrolünü atla (force)
  const result = await processRegionStore(region, items, source || 'store');
  res.json(result);
});

// ============================================
// BÖLGE BAZLI CRON JOBS
// ============================================

function setupRegionCrons() {
  Object.entries(config.regionSchedules).forEach(([region, schedule]) => {
    // Her bölge için checkInterval dakikada bir kontrol
    const cronExpression = `*/${schedule.checkInterval} * * * *`;
    
    cron.schedule(cronExpression, async () => {
      // Sadece zaman penceresi içindeyse çalış
      if (!isInRegionWindow(region)) {
        return;
      }
      
      console.log(`⏰ [${region}] Cron tetiklendi (${new Date().toISOString()})`);
      
      // Bu bölge için bekleyen skin var mı kontrol et
      const activeSkins = await getActiveSkins('store');
      const regionSkins = activeSkins.filter(s => s.regions.includes(region));
      
      if (regionSkins.length === 0) {
        console.log(`[${region}] Bekleyen skin yok, atlanıyor`);
        return;
      }
      
      console.log(`[${region}] ${regionSkins.length} skin bekleniyor`);
      
      // NOT: Gerçek store verisi client'tan gelir
      // Bu cron sadece aktif olduğumuzu loglar
      regionState[region].isInWindow = true;
    });
    
    console.log(`📅 ${region} cron ayarlandı: ${cronExpression} (${schedule.startHour}:00-${schedule.endHour}:00 UTC)`);
  });
}

// Skin cache güncellemesi (her saat)
cron.schedule('0 * * * *', async () => {
  console.log('🔄 Skin cache güncelleniyor...');
  await getAllSkins();
});

// Cooldown temizliği (her 6 saatte)
cron.schedule('0 */6 * * *', () => {
  console.log('🧹 Eski cooldown kayıtları temizleniyor...');
  const cutoff = Date.now() - NOTIFICATION_COOLDOWN;
  
  Object.values(regionState).forEach(state => {
    let cleaned = 0;
    for (const [id, timestamp] of state.lastNotifiedSkins) {
      if (timestamp < cutoff) {
        state.lastNotifiedSkins.delete(id);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      console.log(`  - ${cleaned} kayıt temizlendi`);
    }
  });
});

// ============================================
// STARTUP
// ============================================

const PORT = process.env.PORT || 3001;

async function start() {
  console.log('🚀 ValoHub Worker başlatılıyor...');
  console.log('📍 Bölge bazlı zamanlama aktif');
  
  // Skin cache yükle
  await getAllSkins();
  
  // Cron'ları ayarla
  setupRegionCrons();
  
  // Aktif bölgeleri göster
  const activeNow = getActiveRegions();
  if (activeNow.length > 0) {
    console.log(`🟢 Şu an aktif bölgeler: ${activeNow.join(', ')}`);
  } else {
    console.log('🟡 Şu an aktif bölge yok');
  }
  
  app.listen(PORT, () => {
    console.log(`✅ Worker running on port ${PORT}`);
    console.log(`📡 Backend URL: ${config.backendUrl}`);
    console.log(`📢 Ntfy URL: ${config.ntfyUrl}`);
  });
}

start().catch(console.error);

module.exports = { app, processRegionStore, isInRegionWindow };
