import { createCipheriv, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";

const DAY_SECONDS = 24 * 60 * 60;
const PERIOD_DAYS = 370;
const QUERY_HOSTS = ["query2.finance.yahoo.com", "query1.finance.yahoo.com"];
const PUBLIC_INSTRUMENTS = [
  { id: "nikkei225", label: "日経平均", symbol: "^N225", category: "index", unit: "point" },
  { id: "topix", label: "TOPIX", symbol: "^TOPX", category: "index", unit: "point" },
  { id: "sp500", label: "S&P 500", symbol: "^GSPC", category: "index", unit: "point" },
  { id: "nasdaq", label: "NASDAQ", symbol: "^IXIC", category: "index", unit: "point" },
  { id: "dow", label: "NYダウ", symbol: "^DJI", category: "index", unit: "point" },
  { id: "sox", label: "SOX", symbol: "^SOX", category: "index", unit: "point" },
  { id: "vix", label: "VIX", symbol: "^VIX", category: "index", unit: "point" },
  { id: "usdjpy", label: "USD/JPY", symbol: "USDJPY=X", category: "fx", unit: "yen" },
];
const ESSENTIAL_IDS = new Set(["nikkei225", "sp500", "nasdaq"]);
const coverageThreshold = 0.8;
const delayMs = 650;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function asFinite(value) { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function dateFromTimestamp(timestamp) { return Number.isFinite(timestamp) ? new Date(timestamp * 1000).toISOString().slice(0, 10) : null; }

function normalizeChartPayload(payload, instrument, retrievedAt) {
  const result = payload?.chart?.result?.[0];
  const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : [];
  const quote = result?.indicators?.quote?.[0] || {};
  const points = timestamps.map((timestamp, index) => ({ date: dateFromTimestamp(timestamp), close: asFinite(quote.close?.[index]) })).filter((point) => point.date && point.close !== null);
  const current = points.at(-1)?.close ?? null;
  const previous = points.at(-2)?.close ?? null;
  const metadata = result?.meta || {};
  const asOfTimestamp = asFinite(metadata.regularMarketTime) ?? timestamps.at(-1) ?? null;
  return {
    id: instrument.id,
    label: instrument.label,
    category: instrument.category,
    unit: instrument.unit,
    status: points.length ? "confirmed" : "not_obtained",
    current,
    previous_close: previous,
    change: current !== null && previous !== null ? current - previous : null,
    change_percent: current !== null && previous !== null && previous !== 0 ? ((current - previous) / previous) * 100 : null,
    as_of_at: points.length && asOfTimestamp !== null ? new Date(asOfTimestamp * 1000).toISOString() : null,
    as_of_date: points.length ? dateFromTimestamp(asOfTimestamp) : null,
    exchange: points.length ? metadata.exchangeName || null : null,
    timezone: points.length ? metadata.exchangeTimezoneName || null : null,
    points,
    retrieved_at: retrievedAt,
  };
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json", "User-Agent": "stock-dashboard-market-feed/1.0" }, cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  return response.json();
}

async function fetchInstrument(instrument, nowDate) {
  const period2 = Math.floor(nowDate.getTime() / 1000) + DAY_SECONDS;
  const period1 = period2 - PERIOD_DAYS * DAY_SECONDS;
  for (const host of QUERY_HOSTS) {
    const url = `https://${host}/v8/finance/chart/${encodeURIComponent(instrument.symbol)}?period1=${period1}&period2=${period2}&interval=1d&events=history`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try { return normalizeChartPayload(await fetchJson(url), instrument, nowDate.toISOString()); }
      catch { if (attempt === 0) await sleep(400); }
    }
    await sleep(delayMs);
  }
  return { id: instrument.id, label: instrument.label, category: instrument.category, unit: instrument.unit, status: "not_obtained", current: null, previous_close: null, change: null, change_percent: null, as_of_at: null, as_of_date: null, exchange: null, timezone: null, points: [], retrieved_at: nowDate.toISOString() };
}

function readKey() {
  const raw = process.env.MARKET_FEED_KEY_B64 || "";
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("MARKET_FEED_KEY_B64 must decode to 32 bytes");
  return key;
}

function readSymbolMap() {
  const raw = process.env.PORTFOLIO_SYMBOL_MAP_JSON || "";
  const parsed = JSON.parse(raw);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("PORTFOLIO_SYMBOL_MAP_JSON must be an object");
  for (const [feedId, symbol] of Object.entries(parsed)) {
    if (!/^holding-[a-f0-9-]{36}$/.test(feedId) || typeof symbol !== "string" || !/^[0-9A-Z]{4,6}\.T$/.test(symbol)) throw new Error("invalid opaque symbol map");
  }
  return parsed;
}

function encryptPayload(payload, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { schema_version: 1, generated_at: payload.generated_at, encryption: { algorithm: "AES-256-GCM", iv_b64: iv.toString("base64"), tag_b64: tag.toString("base64") }, ciphertext_b64: ciphertext.toString("base64") };
}

const nowDate = new Date();
const generatedAt = nowDate.toISOString();
const key = readKey();
const symbolMap = readSymbolMap();
const instruments = [];
for (const instrument of PUBLIC_INSTRUMENTS) { instruments.push(await fetchInstrument(instrument, nowDate)); await sleep(delayMs); }
const holdingPrices = {};
for (const [feedId, symbol] of Object.entries(symbolMap)) {
  holdingPrices[feedId] = await fetchInstrument({ id: feedId, label: "保有銘柄", symbol, category: "holding", unit: "yen" }, nowDate);
  await sleep(delayMs);
}
const confirmedPublic = instruments.filter((item) => item.status === "confirmed").length;
const coverage = (confirmedPublic + Object.values(holdingPrices).filter((item) => item.status === "confirmed").length) / (instruments.length + Object.keys(holdingPrices).length || 1);
const missingEssential = [...ESSENTIAL_IDS].filter((id) => instruments.find((item) => item.id === id)?.status !== "confirmed");
if (coverage < coverageThreshold || missingEssential.length) throw new Error(`coverage protection: ${Math.round(coverage * 100)}% / missing essential ${missingEssential.length}`);
const payload = { schema_version: 1, generated_at: generatedAt, provider: "Yahoo Finance chart endpoint", delivery_status: "scheduled_feed", delay_notice: "公開市場データは遅延・欠損する場合があります。投資判断の唯一の根拠にはしないでください。", instruments, holding_prices: holdingPrices };
await writeFile("market-feed.enc.json", JSON.stringify(encryptPayload(payload, key), null, 2) + "\n", { mode: 0o644 });
console.log(JSON.stringify({ generated_at: generatedAt, public_confirmed: confirmedPublic, public_total: instruments.length, holdings_confirmed: Object.values(holdingPrices).filter((item) => item.status === "confirmed").length, holdings_total: Object.keys(holdingPrices).length, coverage: Number(coverage.toFixed(4)) }));
