"use strict";

  const GH_USER = "[A-Za-z0-9_](?:[A-Za-z0-9_]|-(?=[A-Za-z0-9_])){0,38}";

  const GH_URL_RE = new RegExp(
    "(?:(?:https?:\\/\\/)?(?:www\\.)?github\\.com|git@github\\.com)[:/](" + GH_USER + ")/([A-Za-z0-9._-]{1,100}?)(?:\\.git)?(?![A-Za-z0-9._-])",
    "gi"
  );

  const MENTION_RE = /(?:^|[^\w@#])@([A-Za-z0-9_]{1,15})/g;

  const GH_ID_PREFIX =
    "(?:github\\s*(?:id|name|用户名|账号)|(?<![\\w])gh\\s*(?:id|name)|(?<![\\w])gh(?=[\\s:：])|(?<![\\w])github(?=[\\s:：]))";
  const GH_ID_RE = new RegExp(
    GH_ID_PREFIX + "\\s*[:：]?\\s*@?(" + GH_USER + ")",
    "gi"
  );

  function cleanUrl(owner, repo, m) {
    const scheme = m.includes("://") || m.startsWith("git@") ? (m.startsWith("git@") ? "git@" : "https://") : "";
    const url = m.startsWith("git@")
      ? `git@github.com:${owner}/${repo}`
      : (m.includes("://") ? "https://" : "") + `github.com/${owner}/${repo}`;
    return { url, owner, repo };
  }

  function extractRepos(text) {
    const out = [];
    const seen = new Set();
    GH_URL_RE.lastIndex = 0;
    let m;
    while ((m = GH_URL_RE.exec(text)) !== null) {
      const owner = m[1];
      const repo = m[2].replace(/\.+$/, "");
      const key = owner.toLowerCase() + "/" + repo.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(cleanUrl(owner, repo, m[0]));
    }
    return out;
  }

  function extractMentions(text) {
    const out = [];
    const seen = new Set();
    MENTION_RE.lastIndex = 0;
    let m;
    while ((m = MENTION_RE.exec(text)) !== null) {
      const h = m[1];
      if (seen.has(h.toLowerCase())) continue;
      seen.add(h.toLowerCase());
      out.push(h);
    }
    return out;
  }

  function extractGithubIds(text) {
    const out = [];
    const seen = new Set();
    GH_ID_RE.lastIndex = 0;
    let m;
    while ((m = GH_ID_RE.exec(text)) !== null) {
      const id = m[1];
      if (seen.has(id.toLowerCase())) continue;
      seen.add(id.toLowerCase());
      out.push(id);
    }
    return out;
  }

  function splitReplies(text, opts = {}) {
    text = String(text || "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
    const headerEnd = text.startsWith("---\n") ? text.indexOf("\n---\n") : -1;
    if (headerEnd !== -1) text = text.slice(headerEnd + 5).trim();
    const lines = text.split("\n");
    const blocks = [];
    let cur = null;
    const push = () => {
      if (cur && (cur.lines.length > 0 || cur.author)) blocks.push(cur);
    };
    for (const line of lines) {
      const author = /^@([A-Za-z0-9_-]{1,20})\b/.exec(line.trim());
      if (author && line.trim().length < 40) {
        push();
        cur = { author: author[1], lines: [] };
        continue;
      }
      const quoted = /^(?:回复|Reply)[\s]*@([A-Za-z0-9_-]{1,20})\s*[:：，,]?\s*(.*)$/.exec(line.trim());
      if (quoted) {
        push();
        cur = { author: quoted[1], lines: [] };
        if (quoted[2]) cur.lines.push(quoted[2]);
        continue;
      }
      if (!cur) cur = { author: null, lines: [] };
      cur.lines.push(line);
    }
    push();
    const blocksOut = blocks.map((b) => ({ author: b.author, text: b.lines.join("\n").trim() }));
    if (opts.skipFirst && blocksOut.length > 0) return blocksOut.slice(1);
    return blocksOut;
  }

  function parseReplyBlock(author, text) {
    const githubIds = extractGithubIds(text);
    const repos = extractRepos(text);
    const mentions = extractMentions(text).filter(
      (h) => h.toLowerCase() !== String(author || "").toLowerCase()
    );
    const projectName = repos.length > 0 ? repos[0].repo.replace(/[-_]/g, " ") : "";
    return { author, text, githubIds, repos, mentions, projectName };
  }

  function parseAll(markdown) {
    const blocks = splitReplies(markdown, { skipFirst: false });
    const replies = [];
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const parsed = parseReplyBlock(b.author, b.text);
      if (i === 0 && b.author && String(b.author).toLowerCase() === "tianyi" && b.text.length > 80) continue;
      if (!b.text && !b.author) continue;
      if (!b.text) continue;
      replies.push(parsed);
    }
    return {
      source: "text",
      replies,
      repoSet: () => mergeRepos(replies),
      stats: () => computeStats(replies),
    };
  }

  function mergeRepos(replies) {
    const map = new Map();
    for (const r of replies) {
      for (const repo of r.repos) {
        const key = repo.owner.toLowerCase() + "/" + repo.repo.toLowerCase();
        if (!map.has(key)) {
          map.set(key, {
            url: repo.url,
            owner: repo.owner,
            repo: repo.repo,
            fullName: key,
            contributors: [],
            samples: [],
          });
        }
        const e = map.get(key);
        if (r.author && !e.contributors.includes(r.author)) e.contributors.push(r.author);
        e.samples.push({ author: r.author, text: r.text.slice(0, 200) });
      }
    }
    return Array.from(map.values());
  }

  function computeStats(replies) {
    const total = replies.length;
    const withRepo = replies.filter((r) => r.repos.length > 0).length;
    const withId = replies.filter((r) => r.githubIds.length > 0).length;
    const repoCount = mergeRepos(replies).length;
    return { total, withRepo, withId, repoCount };
  }

  function expandEntities(text, entities) {
    for (const u of entities?.urls || []) text = text.replace(u.url, u.expanded_url || u.url);
    return text;
  }

  function parseGuestJson(json, rootId) {
    const out = [];
    const entries = json?.data?.thread?.[0]?.conversation_timeline?.entries || [];
    for (const e of entries) {
      if (e.content?.entryType !== "TimelineTimelineItem") continue;
      const result = e.content.itemContent?.tweet_results?.result;
      if (!result || result.legacy?.retweeted_status_result) continue;
      if ((result.rest_id || result.legacy?.id_str) === String(rootId)) continue;
      const screenName = result.core?.user_results?.result?.legacy?.screen_name;
      let text = result.legacy?.full_text || "";
      if (!text || !screenName) continue;
      text = expandEntities(text, result.legacy?.entities)
        .replace(/\s*https?:\/\/t\.co\/\S+$/i, "")
        .trim();
      out.push(parseReplyBlock(screenName, text));
    }
    return out;
  }

  async function paginateReplies(fetchPage, opts = {}) {
    const { maxPages = 40, delay = 0, rootId = null, onPage } = opts;
    const acc = [];
    const byKey = new Set();
    let cursor = null;
    for (let page = 1; page <= maxPages; page++) {
      const { json, cursor: next } = await fetchPage(cursor);
      const parsed = parseGuestJson(json, rootId);
      let added = 0;
      for (const r of parsed) {
        const key = (r.author || "") + "|" + r.text.slice(0, 80);
        if (byKey.has(key)) continue;
        byKey.add(key);
        acc.push(r);
        added++;
      }
      cursor = next;
      if (onPage) onPage(acc.length, page);
      if (!cursor) break;
      if (page > 1 && added === 0) break;
      if (delay) await new Promise((r) => setTimeout(r, delay));
    }
    return acc;
  }

  export {
    extractRepos,
    extractMentions,
    extractGithubIds,
    splitReplies,
    parseReplyBlock,
    parseAll,
    mergeRepos,
    computeStats,
    expandEntities,
    parseGuestJson,
    paginateReplies,
  };
