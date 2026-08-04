import { readFile, writeFile } from "node:fs/promises";
import { parseGuestJson, paginateReplies } from "./parser.js";

const CONFIG = {
  screenName: "tianyi",
  tweetId: "2084693319188439211",
};

const GH_BEARER = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
const CONVO_PARAMS = "include_profile_interstitial_type=1&include_blocking=1&include_blocked_by=1&include_followed_by=1&include_want_retweets=1&include_mute_edge=1&include_can_dm=1&include_can_media_tag=1&include_ext_has_nft_avatar=1&include_ext_is_blue_verified=1&include_ext_verified_type=1&include_ext_profile_image_shape=1&skip_status=1&card_platform=Web-12&include_cards=1&include_ext_alt_text=true&include_quote_count=true&include_reply_count=1&tweet_mode=extended&simple_quoted_tweet=true&tweet_card_mode=summary_large_image&include_ext_views=true&dm_users=false&include_mentions=true&ext=mediaStats%2ChighlightedLabel%2ChasNftAvatar%2CvoiceInfo%2CbirdwatchPivot%2Cenrichments%2CsuperFollowMetadata%2CliveEvent%2CunifiedCards%2Cvibe%2CeditorsChoice%2CtrendingEvents";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function apiGet(url, token, extraHeaders = {}) {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": UA,
      authorization: "Bearer " + GH_BEARER,
      ...(token ? { "x-guest-token": token } : {}),
      ...extraHeaders,
    },
  });
  if (!resp.ok) throw new Error("HTTP " + resp.status + " for " + url.slice(0, 120));
  return resp;
}

async function getGuestToken() {
  const resp = await apiGet("https://x.com/i/api/1.1/guest/activate.json", null, { method: "POST" });
  const json = await resp.json();
  if (!json.guest_token) throw new Error("guest token 获取失败: " + JSON.stringify(json).slice(0, 300));
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

async function fetchPage(token, cursor) {
  let url = `https://x.com/i/api/2/timeline/conversation/${CONFIG.tweetId}.json?${CONVO_PARAMS}`;
  if (cursor) url += "&cursor=" + encodeURIComponent(cursor);
  const resp = await apiGet(url, token);
  const json = await resp.json();
  if (!json || !json.data) throw new Error("响应缺少 data");
  return { json, cursor: cursorOf(json) };
}

const tweets = [];
let summary = { pages: 0, tweets: 0, errors: [] };

try {
  let token = await getGuestToken();
  let page = 0;
  let cursor = null;
  let stop = false;
  while (!stop && page < 40) {
    page++;
    try {
      const { json, cursor: next } = await fetchPage(token, cursor);
      const parsed = parseGuestJson(json, CONFIG.tweetId);
      tweets.push(...parsed);
      cursor = next;
      console.log(`第 ${page} 页: 累计 ${tweets.length} 条回复`);
      if (!cursor) stop = true;
    } catch (e) {
      if (e.message.includes("HTTP 401") || e.message.includes("HTTP 403")) {
        console.log("token 失效,重新获取…");
        token = await getGuestToken();
        const { json, cursor: next } = await fetchPage(token, cursor);
        tweets.push(...parseGuestJson(json, CONFIG.tweetId));
        cursor = next;
        if (!cursor) stop = true;
      } else {
        throw e;
      }
    }
    if (!stop) await new Promise((r) => setTimeout(r, 400));
  }
  summary = { pages: page, tweets: tweets.length, errors: [] };
} catch (e) {
  summary.errors.push(e.message);
  console.error("抓取失败:", e.message);
}

const seen = new Set();
const deduped = tweets.filter((t) => {
  const k = (t.author || "") + "|" + t.text.slice(0, 80);
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

const out = {
  tweetId: CONFIG.tweetId,
  tweetUrl: `https://x.com/${CONFIG.screenName}/status/${CONFIG.tweetId}`,
  fetchedAt: new Date().toISOString(),
  summary,
  replies: deduped,
};

await writeFile("data/replies.json", JSON.stringify(out, null, 2), "utf8");
console.log("已写入 data/replies.json,共", deduped.length, "条");

const old = await readFile("data/replies.json", "utf8").catch(() => null);
if (old) console.log("data/replies.json 已存在,将被覆盖");
