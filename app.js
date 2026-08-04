import { parseAll, parseReplyBlock, mergeRepos, paginateReplies } from "./parser.js";

const CONFIG = {
  screenName: "tianyi",
  tweetId: "2084693319188439211",
  tweetUrl: "https://x.com/tianyi/status/2084693319188439211",
  fallbackMeta: {
    author: "Tianyi Cui",
    handle: "tianyi",
    likes: 394,
    replies: 136,
    retweets: 35,
    text: "如果您在做 Agent Harness 相关的开源项目，希望在 DeepSeek Harness 发布的第一时间进行接入支持，请回复您的 GitHub id 以及 GitHub 项目地址，包括但不限于 plugin, skill, MCP, orchestrator, aggregator, UI 等等。",
  },
};

const LS = {
  data: "xrs.data",
  contacts: "xrs.contacts",
  repoCache: "xrs.repoCache",
  guestToken: "xrs.guestToken",
};

const STATE = {
  replies: [],
  repos: [],
  filter: "all",
  query: "",
  sort: "stars",
  contacts: load(LS.contacts, []),
  enriched: 0,
};

const $ = (id) => document.getElementById(id);
const el = {
  log: $("log"),
  fetchBtn: $("fetchBtn"),
  pasteBtn: $("pasteBtn"),
  exportBtn: $("exportBtn"),
  statsRow: $("statsRow"),
  toolbar: $("toolbar"),
  grid: $("grid"),
  peopleSection: $("peopleSection"),
  empty: $("empty"),
  search: $("search"),
  sort: $("sort"),
  langsBox: $("langsBox"),
  langBars: $("langBars"),
  contactsInput: $("contactsInput"),
  contactsSave: $("contactsSave"),
  contactsStatus: $("contactsStatus"),
  contactsBanner: $("contactsBanner"),
  bannerList: $("bannerList"),
  bannerFilterBtn: $("bannerFilterBtn"),
  pasteDialog: $("pasteDialog"),
  pasteInput: $("pasteInput"),
  progressBox: $("progressBox"),
  progressFill: $("progressFill"),
  progressText: $("progressText"),
  stContactsCard: $("stContactsCard"),
};

const LANG_COLORS = {
  JavaScript: "#f1e05a", TypeScript: "#3178c6", Python: "#3572A5", Go: "#00ADD8",
  Rust: "#dea584", Java: "#b07219", "C++": "#f34b7d", C: "#555555", "C#": "#178600",
  PHP: "#4F5D95", Shell: "#89e051", HTML: "#e34c26", CSS: "#563d7c", Vue: "#41b883",
  Swift: "#F05138", Kotlin: "#A97BFF", Dart: "#00B4AB", Ruby: "#701516", Zig: "#ec915c",
};
const langColor = (l) => LANG_COLORS[l] || "#8b949e";

const GH_BEARER = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
const CONVO_PARAMS = "include_profile_interstitial_type=1&include_blocking=1&include_blocked_by=1&include_followed_by=1&include_want_retweets=1&include_mute_edge=1&include_can_dm=1&include_can_media_tag=1&include_ext_has_nft_avatar=1&include_ext_is_blue_verified=1&include_ext_verified_type=1&include_ext_profile_image_shape=1&skip_status=1&card_platform=Web-12&include_cards=1&include_ext_alt_text=true&include_quote_count=true&include_reply_count=1&tweet_mode=extended&simple_quoted_tweet=true&tweet_card_mode=summary_large_image&include_ext_views=true&dm_users=false&include_mentions=true&ext=mediaStats%2ChighlightedLabel%2ChasNftAvatar%2CvoiceInfo%2CbirdwatchPivot%2Cenrichments%2CsuperFollowMetadata%2CliveEvent%2CunifiedCards%2Cvibe%2CeditorsChoice%2CtrendingEvents";

function load(key, def) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? def : v; } catch { return def; }
}
function save(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

function log(msg, cls) {
  el.log.textContent = msg;
  el.log.className = "log" + (cls ? " " + cls : "");
}

async function fetchText(url, opts = {}) {
  const resp = await fetch(url, opts);
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  return resp;
}

async function fetchJina() {
  const url = `https://r.jina.ai/https://x.com/${CONFIG.screenName}/status/${CONFIG.tweetId}`;
  const resp = await fetchText(url);
  const text = await resp.text();
  if (!text || text.length < 200) throw new Error("r.jina.ai 返回内容过短");
  return text;
}

async function guestToken(force = false) {
  const cached = load(LS.guestToken, null);
  if (cached && !force) return cached;
  const proxy = "https://corsproxy.io/?url=" + encodeURIComponent("https://x.com/i/api/1.1/guest/activate.json");
  const resp = await fetchText(proxy, {
    method: "POST",
    headers: { authorization: "Bearer " + GH_BEARER },
  });
  const json = await resp.json();
  if (!json.guest_token) throw new Error("获取 guest token 失败");
  save(LS.guestToken, json.guest_token);
  return json.guest_token;
}

const PROXIES = [
  "https://api.allorigins.win/raw?url=",
  "https://corsproxy.io/?url=",
  "https://api.codetabs.com/v1/proxy?quest=",
];

function cursorOf(json) {
  const entries = json?.data?.thread?.[0]?.conversation_timeline?.entries || [];
  for (const e of entries) {
    if (e.content?.entryType !== "TimelineTimelineCursor") continue;
    return e.content?.value || e.content?.cursorValue || e.value || null;
  }
  return null;
}

async function fetchConvoPage(token, cursor) {
  let base = `https://x.com/i/api/2/timeline/conversation/${CONFIG.tweetId}.json?${CONVO_PARAMS}`;
  if (cursor) base += "&cursor=" + encodeURIComponent(cursor);
  let lastErr = null;
  for (const proxy of PROXIES) {
    try {
      const resp = await fetch(proxy + encodeURIComponent(base), {
        headers: { authorization: "Bearer " + GH_BEARER, "x-guest-token": token },
      });
      if (resp.status === 401 || resp.status === 403) throw new Error("token-unauthorized");
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const json = await resp.json();
      if (!json || !json.data) throw new Error("响应缺少 data");
      return { json, cursor: cursorOf(json) };
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function fetchGuestReplies(onProgress) {
  let token;
  try {
    token = await guestToken();
  } catch (e) {
    throw new Error("guest token 获取失败: " + e.message);
  }
  const pageFetcher = async (cursor) => {
    try {
      return await fetchConvoPage(token, cursor);
    } catch (e) {
      if (e.message !== "token-unauthorized") throw e;
      token = await guestToken(true);
      return await fetchConvoPage(token, cursor);
    }
  };
  return paginateReplies(pageFetcher, {
    rootId: CONFIG.tweetId,
    delay: 250,
    onPage: onProgress,
  });
}

async function fetchTweetMeta() {
  try {
    const resp = await fetchText(`https://api.fxtwitter.com/${CONFIG.screenName}/status/${CONFIG.tweetId}`);
    const j = await resp.json();
    const t = j.tweet;
    if (!t) throw new Error("no tweet");
    CONFIG.expectedReplies = t.replies || null;
    $("postAuthor").innerHTML = `${t.author.name} <span class="handle">@${t.author.screen_name}</span>`;
    $("postText").textContent = t.text;
    $("postStats").innerHTML =
      `<span>💬 <b>${t.replies}</b> 回复</span><span>🔁 <b>${t.retweets}</b></span><span>❤️ <b>${t.likes}</b></span>` +
      (t.created_at ? `<span>📅 ${new Date(t.created_at).toLocaleString("zh-CN")}</span>` : "");
  } catch {
    const m = CONFIG.fallbackMeta;
    CONFIG.expectedReplies = m.replies || null;
    $("postAuthor").innerHTML = `${m.author} <span class="handle">@${m.handle}</span>`;
    $("postText").textContent = m.text;
    $("postStats").innerHTML = `<span>💬 <b>${m.replies}</b> 回复</span><span>🔁 <b>${m.retweets}</b></span><span>❤️ <b>${m.likes}</b></span>`;
  }
  $("tweetLink").href = CONFIG.tweetUrl;
}

async function updateProgress(fetched, page) {
  const expected = CONFIG.expectedReplies;
  el.progressBox.hidden = false;
  const pct = expected ? Math.min(100, Math.round((fetched / expected) * 100)) : 0;
  el.progressFill.style.width = pct + "%";
  el.progressFill.classList.toggle("full", pct >= 100);
  el.progressText.textContent = expected ? `${fetched} / ${expected}` : `${fetched} 条`;
  el.log.textContent = `⏳ 正在抓取: 已获取 ${fetched} 条回复(第 ${page} 页)…`;
}

async function doFetch() {
  el.fetchBtn.disabled = true;
  el.progressBox.hidden = false;
  el.progressFill.style.width = "0%";
  log("⏳ 来源 1: X 游客 API(翻页抓取全部回复)…");

  try {
    const replies = await fetchGuestReplies(async (count, page) => {
      await updateProgress(count, page);
    });
    if (replies.length === 0) throw new Error("游客 API 返回 0 条回复");
    ingest(replies, "x-guest-api");
    const total = CONFIG.expectedReplies;
    log(total
      ? `✅ 抓取完成: ${replies.length} / ${total} 条回复(页面完整度 ${Math.round((replies.length / total) * 100)}%)`
      : `✅ 抓取完成: ${replies.length} 条回复`, "ok");
    el.progressFill.style.width = "100%";
    el.progressFill.classList.add("full");
    el.fetchBtn.disabled = false;
    return;
  } catch (e) {
    log(`⚠️ 游客 API 失败: ${e.message}\n来源 2: r.jina.ai 渲染…`);
  }

  try {
    const text = await fetchJina();
    const out = parseAll(text);
    if (out.replies.length > 0) {
      ingest(out.replies, "r.jina.ai");
      log(`✅ r.jina.ai 抓取成功: ${out.replies.length} 条回复(仅页面可见部分,建议重试游客 API)`, "ok");
    } else {
      log("❌ 自动抓取全部失败:\n  r.jina.ai 未解析出回复(X 可能要求登录)\n\n👉 请点击「粘贴文本解析」手动导入回复内容。", "err");
    }
  } catch (e) {
    log(`❌ 自动抓取全部失败:\n  游客 API: ${e.message}\n  r.jina.ai: ${e2.message}\n\n👉 手动方案:打开 ${CONFIG.tweetUrl} 把回复文本复制后点「粘贴文本解析」;\n👉 或打开 https://r.jina.ai/${CONFIG.tweetUrl} 全选复制粘贴。`, "err");
  }
  el.fetchBtn.disabled = false;
}

function ingest(replies, source) {
  STATE.replies = replies;
  STATE.repos = mergeRepos(replies);
  save(LS.data, { source, replies, ts: Date.now() });
  render();
}

function showEmpty() {
  el.empty.hidden = !(STATE.replies.length === 0);
  el.grid.innerHTML = "";
  el.peopleSection.innerHTML = "";
}

function contactsForReply(r) {
  const names = [r.author, ...r.githubIds, ...r.mentions].filter(Boolean).map((x) => x.toLowerCase());
  return STATE.contacts.filter((c) => names.includes(c.toLowerCase()));
}

function isRepoContact(repo) {
  if (STATE.contacts.some((c) => c.toLowerCase() === repo.owner.toLowerCase())) return true;
  for (const c of repo.contributors) {
    const r = STATE.replies.find((x) => x.author === c);
    if (r && contactsForReply(r).length > 0) return true;
  }
  return false;
}

function matchedContactsCount() {
  const matched = new Set();
  for (const r of STATE.replies) for (const c of contactsForReply(r)) matched.add(c.toLowerCase());
  for (const repo of STATE.repos) if (STATE.contacts.some((c) => c.toLowerCase() === repo.owner.toLowerCase())) matched.add(repo.owner.toLowerCase());
  return matched.size;
}

function renderStats() {
  el.statsRow.hidden = false;
  el.toolbar.hidden = false;
  const stars = STATE.repos.reduce((s, r) => s + (r.stars || 0), 0);
  const langs = new Set(STATE.repos.filter((r) => r.language).map((r) => r.language));
  $("stReplies").textContent = STATE.replies.length;
  $("stProjects").textContent = STATE.repos.length;
  $("stWithRepo").textContent = STATE.replies.filter((r) => r.repos.length > 0).length;
  $("stStars").textContent = stars;
  $("stLangs").textContent = langs.size;
  const n = matchedContactsCount();
  $("stContacts").textContent = n;
  $("stContactsCard").classList.toggle("contact-stat", n > 0);
  renderLangs();
}

function renderContactsBanner() {
  if (STATE.contacts.length === 0 || STATE.replies.length === 0) {
    el.contactsBanner.hidden = true;
    return;
  }
  const items = [];
  for (const c of STATE.contacts) {
    const cl = c.toLowerCase();
    const myReplies = STATE.replies.filter((r) => {
      const names = [r.author, ...r.githubIds, ...r.mentions].filter(Boolean).map((x) => x.toLowerCase());
      return names.includes(cl);
    });
    const myRepos = STATE.repos.filter((r) =>
      r.owner.toLowerCase() === cl || (r.contributors.some((a) => {
        const rr = STATE.replies.find((x) => x.author === a);
        return rr && [rr.author, ...rr.githubIds, ...rr.mentions].some((x) => String(x).toLowerCase() === cl);
      }))
    );
    if (myReplies.length === 0 && myRepos.length === 0) continue;
    items.push({ contact: c, replies: myReplies, repos: myRepos });
  }
  el.contactsBanner.hidden = items.length === 0;
  if (items.length === 0) return;
  $("bannerCount").textContent = `${items.length} 位熟人`;
  el.bannerList.innerHTML = items.map((it) => `
    <div class="contact-item">
      <div class="contact-avatar">${it.contact[0].toUpperCase()}</div>
      <div class="contact-main">
        <div class="contact-name">${escapeHtml(it.contact)}</div>
        ${it.repos.length > 0
          ? `<div class="contact-projects">${it.repos.map((r) =>
              `<a href="${r.url.startsWith("http") ? r.url : "https://" + r.url}" target="_blank" rel="noopener">${r.owner}/${r.repo}</a>`).join("")}</div>`
          : `<div class="contact-note">参与了报名(未附项目链接): ${escapeHtml(it.replies[0].text.slice(0, 60))}${it.replies[0].text.length > 60 ? "…" : ""}</div>`}
      </div>
    </div>`).join("");
}

function sortRepos(list) {
  const mode = STATE.sort;
  const arr = [...list];
  if (mode === "stars") {
    arr.sort((a, b) => (b.stars || -1) - (a.stars || -1));
  } else if (mode === "contributors") {
    arr.sort((a, b) => b.contributors.length - a.contributors.length);
  } else {
    arr.sort((a, b) => a.fullName.localeCompare(b.fullName));
  }
  return arr;
}

function renderLangs() {
  const counts = new Map();
  for (const r of STATE.repos) if (r.language) counts.set(r.language, (counts.get(r.language) || 0) + 1);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  el.langsBox.hidden = sorted.length === 0;
  el.langBars.innerHTML = sorted.map(([lang, n], i) => {
    const max = sorted[0][1];
    const pct = Math.round((n / max) * 100);
    return `<div class="langbar"><span><span class="lang-dot" style="background:${langColor(lang)}"></span>${lang}</span>
      <div class="track"><div class="fill" style="width:${pct}%;background:${langColor(lang)}"></div></div><span class="num">${n}</span></div>`;
  }).join("");
}

function matchesSearch(r) {
  if (!STATE.query) return true;
  const q = STATE.query.toLowerCase();
  const hay = [r.repo, r.owner, r.fullName, r.description || "", r.language || "", ...r.contributors,
    ...(r.samples || []).map((s) => s.text || ""), ...(r.githubIds || [])].join(" ").toLowerCase();
  return hay.includes(q);
}
function personMatchesSearch(r) {
  if (!STATE.query) return true;
  const q = STATE.query.toLowerCase();
  const hay = [r.author, ...r.githubIds, ...r.mentions, r.text].join(" ").toLowerCase();
  return hay.includes(q);
}

function render() {
  renderStats();
  renderContactsBanner();
  showEmpty();
  if (STATE.replies.length === 0) return;
  el.exportBtn.disabled = false;

  const f = STATE.filter;
  const showRepo = f === "all" || f === "repo" || f === "contacts";
  const showPeople = f === "all" || f === "people" || f === "contacts";
  const filteredRepos = sortRepos(STATE.repos.filter((r) => matchesSearch(r) && (!(f === "contacts") || isRepoContact(r))));
  const noRepos = STATE.replies.filter((r) => r.repos.length === 0);
  const filteredPeople = noRepos.filter((r) => personMatchesSearch(r) && (!(f === "contacts") || contactsForReply(r).length > 0));

  const hotSet = new Set(
    sortRepos(STATE.repos).filter((r) => r.stars > 0).slice(0, 3).map((r) => r.fullName)
  );

  el.grid.innerHTML = "";
  if (showRepo) for (const repo of filteredRepos) el.grid.appendChild(repoCard(repo, hotSet.has(repo.fullName)));

  el.peopleSection.innerHTML = "";
  if (showPeople && filteredPeople.length > 0) {
    const h = document.createElement("h3");
    h.textContent = `👤 未附项目链接的回复 (${filteredPeople.length})`;
    el.peopleSection.appendChild(h);
    const grid = document.createElement("div");
    grid.className = "people-grid";
    for (const r of filteredPeople) grid.appendChild(personCard(r));
    el.peopleSection.appendChild(grid);
  }
}

function repoCard(repo, hot = false) {
  const card = document.createElement("div");
  card.className = "card";
  card.dataset.fullName = repo.fullName;
  const kontact = isRepoContact(repo);
  if (kontact) card.classList.add("kontact");
  if (hot) card.classList.add("hot");
  const avatarLetter = repo.owner[0]?.toUpperCase() || "?";
  card.innerHTML = `
    <div class="card-top">
      <div class="avatar" data-avatar>${avatarLetter}</div>
      <div class="card-title">
        <a href="${repo.url.startsWith("http") ? repo.url : "https://" + repo.url}" target="_blank" rel="noopener"><span class="owner">${repo.owner}/</span>${repo.repo}</a>
        <div class="ghurl">${repo.url}</div>
      </div>
    </div>
    <div class="card-desc placeholder">加载中…(GitHub API 按需抓取)</div>
    <div class="card-meta"><span class="star">⭐ —</span><span data-lang></span></div>
    <div class="badges">
      ${hot ? `<span class="badge" style="border-color:var(--red);color:var(--red)">🔥 热门</span>` : ""}
      ${kontact ? `<span class="badge kontact">⭐ 熟人参与</span>` : ""}
      <span class="badge">💬 ${repo.contributors.length} 人提交</span>
      ${repo.contributors.map((c) => `<span class="badge ghid">@${c}</span>`).join("")}
    </div>
    <div class="card-foot">
      <span class="replyers">${(repo.samples?.[0]?.text || "").slice(0, 60)}${(repo.samples?.[0]?.text || "").length > 60 ? "…" : ""}</span>
      <a class="open-btn" href="${repo.url.startsWith("http") ? repo.url : "https://" + repo.url}" target="_blank" rel="noopener">打开 ↗</a>
    </div>`;
  if (STATE.repoCache[repo.fullName]) applyEnrich(card, STATE.repoCache[repo.fullName]);
  else io.observe(card);
  return card;
}

function personCard(r) {
  const div = document.createElement("div");
  div.className = "person";
  const kontact = contactsForReply(r).length > 0;
  if (kontact) div.classList.add("kontact");
  const ids = r.githubIds.map((id) => `<span class="badge ghid">🐙 ${id}</span>`).join("");
  const ment = r.mentions.slice(0, 3).map((m) => `<span class="badge">@${m}</span>`).join("");
  div.innerHTML = `
    <div class="who">${r.author || "匿名"} ${kontact ? '<span class="badge kontact">⭐ 熟人</span>' : ""}</div>
    <div class="txt">${escapeHtml(r.text.slice(0, 140))}</div>
    <div class="meta">${ids}${ment}</div>`;
  return div;
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const io = new IntersectionObserver((entries) => {
  for (const en of entries) {
    if (!en.isIntersecting) continue;
    io.unobserve(en.target);
    enrich(en.target.dataset.fullName, en.target);
  }
}, { rootMargin: "300px" });

async function enrich(fullName, cardEl) {
  const cached = STATE.repoCache[fullName];
  if (cached) { applyEnrich(cardEl, cached); return; }
  const [owner, repo] = fullName.split("/");
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  try {
    const resp = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
    const remaining = Number(resp.headers.get("X-RateLimit-Remaining"));
    if (resp.status === 404) {
      STATE.repoCache[fullName] = { deleted: true };
      save(LS.repoCache, STATE.repoCache);
      applyEnrich(cardEl, { deleted: true });
      return;
    }
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const j = await resp.json();
    const info = {
      description: j.description,
      language: j.language,
      stars: j.stargazers_count,
      avatar: j.owner?.avatar_url,
      archived: j.archived,
      pushed_at: j.pushed_at,
      license: j.license?.spdx_id,
      deleted: false,
    };
    STATE.repoCache[fullName] = info;
    save(LS.repoCache, STATE.repoCache);
    applyEnrich(cardEl, info);
    if (remaining === 0) log("⚠️ GitHub API 匿名限额(60次/时)已用完,其余项目暂不加载详情", "err");
  } catch (e) {
    cardEl.querySelector(".card-desc").textContent = "详情加载失败(可能是网络问题,刷新重试)";
  }
}

function applyEnrich(cardEl, info) {
  const desc = cardEl.querySelector(".card-desc");
  const meta = cardEl.querySelector(".card-meta");
  const avatar = cardEl.querySelector("[data-avatar]");
  if (info.deleted) {
    desc.classList.add("placeholder");
    desc.innerHTML = `该项目不存在/私有/已改名 — <a href="https://github.com/search?q=${encodeURIComponent(cardEl.dataset.fullName)}&type=repositories" target="_blank" rel="noopener" style="color:var(--accent)">搜索 GitHub ↗</a>`;
    return;
  }
  desc.classList.remove("placeholder");
  desc.textContent = info.description || "无描述";
  meta.innerHTML = `<span class="star">⭐ ${info.stars ?? 0}</span>` +
    (info.language ? `<span><span class="lang-dot" style="background:${langColor(info.language)}"></span>${info.language}</span>` : "") +
    (info.archived ? `<span style="color:var(--red)">🗄 已归档</span>` : "") +
    (info.license ? `<span>${info.license}</span>` : "") +
    (info.pushed_at ? `<span>📅 ${new Date(info.pushed_at).toLocaleDateString("zh-CN")} 更新</span>` : "");
  if (info.avatar) {
    avatar.innerHTML = `<img src="${info.avatar}" width="34" height="34" style="border-radius:8px" alt="" />`;
  }
  renderStats();
}

el.fetchBtn.addEventListener("click", doFetch);

el.pasteBtn.addEventListener("click", () => el.pasteDialog.showModal());
el.pasteDialog.addEventListener("close", () => {
  if (el.pasteDialog.returnValue !== "ok") return;
  const text = el.pasteInput.value.trim();
  if (!text) return;
  const out = parseAll(text);
  if (out.replies.length === 0) {
    log("❌ 未能从粘贴文本中解析出任何回复", "err");
    return;
  }
  const merged = [...STATE.replies, ...out.replies];
  const byKey = new Map();
  for (const r of merged) {
    const key = (r.author || "") + "|" + r.text.slice(0, 80);
    if (!byKey.has(key)) byKey.set(key, r);
  }
  ingest([...byKey.values()], "manual-paste");
  log(`✅ 粘贴解析成功: ${out.replies.length} 条(去重后共 ${byKey.size} 条)`, "ok");
  el.pasteInput.value = "";
});

el.search.addEventListener("input", (e) => { STATE.query = e.target.value.trim(); render(); });

el.sort.addEventListener("change", (e) => { STATE.sort = e.target.value; render(); });

el.bannerFilterBtn.addEventListener("click", () => {
  document.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
  const chip = document.querySelector('.chip[data-filter="contacts"]');
  chip.classList.add("active");
  STATE.filter = "contacts";
  render();
  document.getElementById("toolbar").scrollIntoView({ behavior: "smooth", block: "start" });
});

document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    document.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    STATE.filter = chip.dataset.filter;
    render();
  });
});

el.contactsInput.value = STATE.contacts.join("\n");
el.contactsSave.addEventListener("click", () => {
  STATE.contacts = el.contactsInput.value.split("\n").map((s) => s.trim()).filter(Boolean);
  save(LS.contacts, STATE.contacts);
  el.contactsStatus.textContent = `已保存 ${STATE.contacts.length} 人`;
  render();
});

el.exportBtn.addEventListener("click", () => {
  const blob = new Blob([JSON.stringify({
    config: CONFIG,
    ts: Date.now(),
    replies: STATE.replies,
    repos: STATE.repos,
    repoCache: STATE.repoCache,
  }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `x-replies-${CONFIG.tweetId}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

async function loadRemoteSnapshot() {
  try {
    const resp = await fetch("data/replies.json", { cache: "no-cache" });
    if (!resp.ok) return null;
    const j = await resp.json();
    if (!j || !Array.isArray(j.replies) || j.replies.length === 0) return null;
    return j;
  } catch {
    return null;
  }
}

const APP_VERSION = "2026-08-05b";

fetchTweetMeta();
$("version").textContent = "v" + APP_VERSION;
const saved = load(LS.data, null);
(async () => {
  const remote = await loadRemoteSnapshot();
  if (remote && remote.replies.length > 0) {
    const remoteCount = remote.replies.length;
    const localCount = saved ? saved.replies.length : 0;
    if (!saved || remoteCount >= localCount) {
      STATE.replies = remote.replies;
      STATE.repos = mergeRepos(remote.replies);
      STATE.repoCache = load(LS.repoCache, {});
      render();
      el.exportBtn.disabled = false;
      const pct = CONFIG.expectedReplies ? `(帖子显示 ${CONFIG.expectedReplies} 条,完整度 ${Math.round((remoteCount / CONFIG.expectedReplies) * 100)}%)` : "";
      log(`📦 已加载预抓取快照: ${remoteCount} 条回复 ${pct}\n快照时间: ${new Date(remote.fetchedAt).toLocaleString("zh-CN")}\n如数据过旧,可点击「抓取回复」实时刷新。`, "ok");
      return;
    }
  }
  if (saved && Array.isArray(saved.replies) && saved.replies.length > 0) {
    STATE.replies = saved.replies;
    STATE.repos = mergeRepos(saved.replies);
    STATE.repoCache = load(LS.repoCache, {});
    render();
    log(`📦 已恢复上次缓存数据(${saved.replies.length} 条,来源: ${saved.source})。可重新「抓取回复」更新。`);
  } else {
    STATE.repoCache = load(LS.repoCache, {});
    showEmpty();
  }
})();
