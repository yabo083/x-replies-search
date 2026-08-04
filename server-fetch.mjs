import { readFile, writeFile } from "node:fs/promises";
import { parseAll, parseGuestJson } from "./parser.js";

const CONFIG = {
  screenName: "tianyi",
  tweetId: "2084693319188439211",
};

const GH_BEARER = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
const CONVO_PARAMS = "include_profile_interstitial_type=1&include_blocking=1&include_blocked_by=1&include_followed_by=1&include_want_retweets=1&include_mute_edge=1&include_can_dm=1&include_can_media_tag=1&include_ext_has_nft_avatar=1&include_ext_is_blue_verified=1&include_ext_verified_type=1&include_ext_profile_image_shape=1&skip_status=1&card_platform=Web-12&include_cards=1&include_ext_alt_text=true&include_quote_count=true&include_reply_count=1&tweet_mode=extended&simple_quoted_tweet=true&tweet_card_mode=summary_large_image&include_ext_views=true&dm_users=false&include_mentions=true&ext=mediaStats%2ChighlightedLabel%2ChasNftAvatar%2CvoiceInfo%2CbirdwatchPivot%2Cenrichments%2CsuperFollowMetadata%2CliveEvent%2CunifiedCards%2Cvibe%2CeditorsChoice%2CtrendingEvents";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const STATUS_URL = `https://x.com/${CONFIG.screenName}/status/${CONFIG.tweetId}`;

const NITTERS = [
  "https://nitter.poast.org",
  "https://nitter.privacyredirect.com",
];

async function fetchJina() {
  const resp = await fetch("https://r.jina.ai/" + STATUS_URL, {
    headers: { "User-Agent": UA },
  });
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  const text = await resp.text();
  if (!text || text.length < 200) throw new Error("内容过短");
  return text;
}

async function apiGet(url, token) {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": UA,
      authorization: "Bearer " + GH_BEARER,
      ...(token ? { "x-guest-token": token } : {}),
    },
  });
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  return resp;
}

async function getGuestToken() {
  const resp = await apiGet("https://x.com/i/api/1.1/guest/activate.json", null);
  const json = await resp.json();
  if (!json.guest_token) throw new Error("无 guest_token: " + JSON.stringify(json).slice(0, 200));
  return json.guest_token;
}

function cursorOf(json) {
  const entries = json?.data?.thread?.[0]?.conversation_timeline?.entries || [];
  for (const e of entries) {
    if (e.content?.entryType !== "TimelineTimelineCursor") continue;
    return e.content?.value || e.content?.cursorValue || e.value || null;
  }
  return null;
}

async function fetchGuestReplies() {
  let token = await getGuestToken();
  const acc = [];
  const byKey = new Set();
  let cursor = null;
  for (let page = 1; page <= 40; page++) {
    let url = `https://x.com/i/api/2/timeline/conversation/${CONFIG.tweetId}.json?${CONVO_PARAMS}`;
    if (cursor) url += "&cursor=" + encodeURIComponent(cursor);
    let json;
    try {
      const resp = await apiGet(url, token);
      json = await resp.json();
    } catch (e) {
      if (e.message.includes("HTTP 401") || e.message.includes("HTTP 403")) {
        token = await getGuestToken();
        const resp = await apiGet(url, token);
        json = await resp.json();
      } else {
        throw e;
      }
    }
    if (!json?.data) throw new Error("响应缺少 data");
    const parsed = parseGuestJson(json, CONFIG.tweetId);
    let added = 0;
    for (const r of parsed) {
      const k = (r.author || "") + "|" + r.text.slice(0, 80);
      if (byKey.has(k)) continue;
      byKey.add(k);
      acc.push(r);
      added++;
    }
    console.log(`  guest 第 ${page} 页: 累计 ${acc.length} 条`);
    cursor = cursorOf(json);
    if (!cursor) break;
    if (page > 1 && added === 0) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  return acc;
}

async function fetchNitter() {
  for (const base of NITTERS) {
    try {
      const resp = await fetch(`${base}/${CONFIG.screenName}/status/${CONFIG.tweetId}`, {
        headers: { "User-Agent": UA },
      });
      if (!resp.ok) continue;
      const text = await resp.text();
      if (!text.includes("tweet-body") && !text.includes("reply")) continue;
      const out = parseAll(text.replace(/<[^>]+>/g, "\n"));
      if (out.replies.length > 0) {
        console.log(`  nitter ${base} 成功: ${out.replies.length} 条`);
        return out.replies;
      }
    } catch { continue; }
  }
  return [];
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((t) => {
    const k = (t.author || "") + "|" + t.text.slice(0, 80);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const sources = [];
let replies = [];
let errors = [];

try {
  console.log("来源 1: r.jina.ai…");
  const text = await fetchJina();
  const out = parseAll(text);
  if (out.replies.length > 0) {
    replies = out.replies;
    sources.push(`r.jina.ai(${replies.length} 条)`);
    console.log(`  r.jina.ai 成功: ${replies.length} 条`);
  } else {
    errors.push("r.jina.ai 未解析出回复");
    console.log("  r.jina.ai 未解析出回复");
  }
} catch (e) {
  errors.push("r.jina.ai: " + e.message);
  console.log("  r.jina.ai 失败:", e.message);
}

if (replies.length === 0) {
  try {
    console.log("来源 2: X 游客 API…");
    replies = await fetchGuestReplies();
    if (replies.length > 0) sources.push(`x-guest-api(${replies.length} 条)`);
  } catch (e) {
    errors.push("x-guest-api: " + e.message);
    console.log("  guest API 失败:", e.message);
  }
}

if (replies.length === 0) {
  console.log("来源 3: nitter 镜像…");
  replies = await fetchNitter();
  if (replies.length > 0) sources.push(`nitter(${replies.length} 条)`);
}

replies = dedupe(replies);

const out = {
  tweetId: CONFIG.tweetId,
  tweetUrl: STATUS_URL,
  fetchedAt: new Date().toISOString(),
  sources,
  errors,
  summary: { tweets: replies.length },
  replies,
};

const prev = await readFile("data/replies.json", "utf8").then(JSON.parse).catch(() => null);
if (prev && Array.isArray(prev.replies)) {
  const byKey = new Map();
  for (const r of prev.replies) byKey.set((r.author || "") + "|" + r.text.slice(0, 80), r);
  for (const r of replies) byKey.set((r.author || "") + "|" + r.text.slice(0, 80), r);
  replies = dedupe([...byKey.values()]);
  out.replies = replies;
  out.merged = true;
  console.log(`与历史快照合并后共 ${replies.length} 条`);
}

await writeFile("data/replies.json", JSON.stringify(out, null, 2), "utf8");
console.log("已写入 data/replies.json:", replies.length, "条 | 来源:", sources.join(" + ") || "无", errors.length ? "| 错误: " + errors.join("; ") : "");
