import { createCipheriv, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const DAY_SECONDS = 24 * 60 * 60;
const PERIOD_DAYS = 370;
const QUERY_HOSTS = ["query2.finance.yahoo.com", "query1.finance.yahoo.com"];
const PUBLIC_INSTRUMENTS = [
  { id: "nikkei225", label: "日経平均", symbol: "^N225", category: "index", unit: "point" },
  { id: "topix", label: "TOPIX", symbol: "998405.T", category: "index", unit: "point" },
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

function parseYahooNumber(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const number = Number(String(value).replace(/,/g, "").replace(/%$/, ""));
  return Number.isFinite(number) ? number : null;
}

function parseYahooJapanDate(value) {
  const match = String(value || "").match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!match) return null;
  const [, year, month, day, hour = "15", minute = "30"] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${hour.padStart(2, "0")}:${minute}:00+09:00`;
}

function escapedField(section, key) {
  const match = section.match(new RegExp(`\\\\?"${key}\\\\?":\\\\?"([^"\\\\]*)`));
  return match?.[1] || null;
}

export function parseYahooJapanTopixCurrent(html) {
  const markers = ['\\"mainDomesticIndexPriceBoard\\":{\\"indexPrices\\":{', '"mainDomesticIndexPriceBoard":{"indexPrices":{"'];
  const marker = markers.find((candidate) => html.includes(candidate));
  const start = marker ? html.indexOf(marker) : -1;
  if (start < 0) throw new Error("TOPIX current board not found");
  const end = Math.min(...['},\\"currentTabNavigationKey', '},"currentTabNavigationKey'].map((candidate) => { const index = html.indexOf(candidate, start); return index < 0 ? Number.POSITIVE_INFINITY : index; }));
  const section = html.slice(start, Number.isFinite(end) ? end : start + 20000);
  const current = parseYahooNumber(escapedField(section, "price"));
  const change = parseYahooNumber(escapedField(section, "changePrice"));
  const previous = parseYahooNumber(escapedField(section, "previousPrice")) ?? (current !== null && change !== null ? current - change : null);
  const changePercent = parseYahooNumber(escapedField(section, "changePriceRate"));
  const update = parseYahooJapanDate(escapedField(section, "japanUpdateTime"));
  if (current === null || previous === null) throw new Error("TOPIX current values not found");
  return {
    current,
    previous_close: previous,
    change: change ?? current - previous,
    change_percent: changePercent ?? (previous ? ((current - previous) / previous) * 100 : null),
    as_of_at: update,
  };
}

export function parseYahooJapanTopixHistory(html, { now = new Date(), periodDays = PERIOD_DAYS } = {}) {
  const cutoff = now.getTime() - periodDays * DAY_SECONDS * 1000;
  const points = [];
  const pattern = /\\"date\\":\\"(\d{4}\/\d{1,2}\/\d{1,2})\\",\\"openPrice\\":\\"([^"\\]*)\\",\\"highPrice\\":\\"([^"\\]*)\\",\\"lowPrice\\":\\"([^"\\]*)\\",\\"closePrice\\":\\"([^"\\]*)\\"/g;
  for (const match of html.matchAll(pattern)) {
    const date = match[1].replace(/\//g, "-").replace(/-(\d)(?=-|$)/g, "-0$1");
    const close = parseYahooNumber(match[5]);
    if (!Number.isFinite(close)) continue;
    const pointTime = new Date(`${date}T00:00:00+09:00`).getTime();
    if (Number.isFinite(pointTime) && pointTime >= cutoff) points.push({ date, close });
  }
  const unique = new Map(points.map((point) => [point.date, point]));
  return [...unique.values()].sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchText(url, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(url, { headers: { accept: "text/html", "User-Agent": "stock-dashboard-market-feed/1.0" }, cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  return response.text();
}

export async function fetchYahooJapanTopix({ fetchImpl = globalThis.fetch, now = () => new Date(), periodDays = PERIOD_DAYS, maxPages = 20, requestDelayMs = 250 } = {}) {
  const nowDate = now();
  const currentHtml = await fetchText("https://finance.yahoo.co.jp/quote/998405.T", fetchImpl);
  const current = parseYahooJapanTopixCurrent(currentHtml);
  const points = [];
  let reachedCutoff = false;
  for (let page = 1; page <= maxPages && !reachedCutoff; page += 1) {
    const historyHtml = await fetchText(`https://finance.yahoo.co.jp/quote/998405.T/history?page=${page}`, fetchImpl);
    const pagePoints = parseYahooJapanTopixHistory(historyHtml, { now: nowDate, periodDays });
    points.push(...pagePoints);
    if (!pagePoints.length || pagePoints[0].date <= new Date(nowDate.getTime() - periodDays * DAY_SECONDS * 1000).toISOString().slice(0, 10)) reachedCutoff = true;
    if (page < maxPages && !reachedCutoff) await sleep(requestDelayMs);
  }
  const unique = new Map(points.map((point) => [point.date, point]));
  const sortedPoints = [...unique.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (!sortedPoints.length) throw new Error("TOPIX history not found");
  return {
    id: "topix",
    label: "TOPIX",
    symbol: "998405.T",
    category: "index",
    unit: "point",
    provider: "Yahoo!ファイナンス日本版",
    status: "confirmed",
    current: current.current,
    previous_close: current.previous_close,
    change: current.change,
    change_percent: current.change_percent,
    as_of_at: current.as_of_at || `${sortedPoints.at(-1).date}T15:30:00+09:00`,
    as_of_date: sortedPoints.at(-1).date,
    exchange: "東京証券取引所",
    timezone: "Asia/Tokyo",
    points: sortedPoints,
    retrieved_at: nowDate.toISOString(),
  };
}

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
  if (instrument.id === "topix") {
    try { return await fetchYahooJapanTopix({ now: () => nowDate }); }
    catch { return { ...instrument, provider: "Yahoo!ファイナンス日本版", status: "not_obtained", current: null, previous_close: null, change: null, change_percent: null, as_of_at: null, as_of_date: null, exchange: null, timezone: null, points: [], retrieved_at: nowDate.toISOString() }; }
  }
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

export async function main() {
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
  const payload = { schema_version: 1, generated_at: generatedAt, provider: "Yahoo Finance chart endpoint + Yahoo!ファイナンス日本版(TOPIX)", delivery_status: "scheduled_feed", delay_notice: "公開市場データは遅延・欠損する場合があります。投資判断の唯一の根拠にはしないでください。", instruments, holding_prices: holdingPrices };
  await writeFile("market-feed.enc.json", JSON.stringify(encryptPayload(payload, key), null, 2) + "\n", { mode: 0o644 });
  console.log(JSON.stringify({ generated_at: generatedAt, public_confirmed: confirmedPublic, public_total: instruments.length, holdings_confirmed: Object.values(holdingPrices).filter((item) => item.status === "confirmed").length, holdings_total: Object.keys(holdingPrices).length, coverage: Number(coverage.toFixed(4)) }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
