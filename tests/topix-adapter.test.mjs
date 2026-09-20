import assert from "node:assert/strict";
import { fetchYahooJapanTopix, parseYahooJapanTopixCurrent, parseYahooJapanTopixHistory } from "../fetch-market-feed.mjs";

const currentHtml = String.raw`<script>\"mainDomesticIndexPriceBoard\":{\"indexPrices\":{\"price\":\"4,091.14\",\"changePrice\":\"-3.05\",\"changePriceRate\":\"-0.07\",\"japanUpdateTime\":\"2026/09/18 15:30\"},\"currentTabNavigationKey`;
const historyHtml = String.raw`<script>\"date\":\"2026/9/18\",\"openPrice\":\"4,107.48\",\"highPrice\":\"4,110.20\",\"lowPrice\":\"4,080.10\",\"closePrice\":\"4,091.14\"},{\"date\":\"2026/9/17\",\"openPrice\":\"4,090.00\",\"highPrice\":\"4,100.00\",\"lowPrice\":\"4,080.00\",\"closePrice\":\"4,094.19\"}`;

const current = parseYahooJapanTopixCurrent(currentHtml);
assert.equal(current.current, 4091.14);
assert.equal(current.previous_close, 4094.19);
assert.equal(current.change, -3.05);
assert.equal(current.change_percent, -0.07);
assert.equal(current.as_of_at, "2026-09-18T15:30:00+09:00");

const points = parseYahooJapanTopixHistory(historyHtml, { now: new Date("2026-09-20T00:00:00+09:00") });
assert.deepEqual(points, [{ date: "2026-09-17", close: 4094.19 }, { date: "2026-09-18", close: 4091.14 }]);

const calls = [];
const fetched = await fetchYahooJapanTopix({
  now: () => new Date("2026-09-20T00:00:00+09:00"),
  requestDelayMs: 0,
  maxPages: 2,
  fetchImpl: async (url) => {
    calls.push(url);
    return new Response(url.includes("/history") ? historyHtml : currentHtml, { status: 200, headers: { "content-type": "text/html" } });
  },
});
assert.equal(fetched.status, "confirmed");
assert.equal(fetched.provider, "Yahoo!ファイナンス日本版");
assert.equal(fetched.points.length, 2);
assert.equal(calls.length, 3, "current plus paginated history pages are fetched");
console.log("TOPIX adapter tests passed: current/history parsing, provider metadata, and paginated fetch.");
