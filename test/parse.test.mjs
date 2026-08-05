import test from "node:test";
import assert from "node:assert/strict";
import {
  extractRepos,
  extractMentions,
  extractGithubIds,
  splitReplies,
  parseReplyBlock,
  parseAll,
  parseGuestJson,
  expandEntities,
  paginateReplies,
} from "../parser.js";

const POST = {
  id: "2084693319188439211",
  screenName: "tianyi",
  text: "如果您在做 Agent Harness 相关的开源项目，希望在 DeepSeek Harness 发布的第一时间进行接入支持，请回复您的 GitHub id 以及 GitHub 项目地址，包括但不限于 plugin, skill, MCP, orchestrator, aggregator, UI 等等。",
};

test("extractRepos: 标准 https URL", () => {
  const r = extractRepos("我的项目 https://github.com/zhang-san/agent-harness-mcp 是 MCP server");
  assert.deepEqual(r, [{ url: "https://github.com/zhang-san/agent-harness-mcp", owner: "zhang-san", repo: "agent-harness-mcp" }]);
});

test("extractRepos: 无协议 + www", () => {
  const r = extractRepos("github.com/alice/skills-collection 我的 skill 合集");
  assert.equal(r.length, 1);
  assert.equal(r[0].owner, "alice");
  assert.equal(r[0].repo, "skills-collection");
  const r2 = extractRepos("www.github.com/bob/x");
  assert.equal(r2.length, 1);
});

test("extractRepos: 尾部 / #fragment ?query 被剥除", () => {
  const r = extractRepos("https://github.com/emma-chen/harness-tools/ 和 https://github.com/david-lin/mcp#readme 和 https://github.com/frank/mcp2?tab=readme");
  assert.deepEqual(r.map((x) => x.owner + "/" + x.repo), ["emma-chen/harness-tools", "david-lin/mcp", "frank/mcp2"]);
});

test("extractRepos: 子路径 /tree/main 只取仓库名", () => {
  const r = extractRepos("https://github.com/hank/toolbox/tree/main/src");
  assert.equal(r[0].owner + "/" + r[0].repo, "hank/toolbox");
});

test("extractRepos: git@ ssh 形式", () => {
  const r = extractRepos("git@github.com:frank-liu/dsh-adaptor.git");
  assert.deepEqual(r[0], { url: "git@github.com:frank-liu/dsh-adaptor", owner: "frank-liu", repo: "dsh-adaptor" });
});

test("extractRepos: 组织名带连字符、仓库名带点", () => {
  const r = extractRepos("https://github.com/deepseek-ai/DeepSeek-Harness 和 https://github.com/user/my.repo");
  assert.deepEqual(r.map((x) => x.owner + "/" + x.repo), ["deepseek-ai/DeepSeek-Harness", "user/my.repo"]);
});

test("extractRepos: 纯个人主页(无仓库)不算项目", () => {
  assert.equal(extractRepos("我的主页 https://github.com/grace-yan").length, 0);
});

test("extractRepos: 一行多个仓库", () => {
  const r = extractRepos("主项目 https://github.com/hank/one 还有 https://github.com/hank/two");
  assert.equal(r.length, 2);
});

test("extractRepos: 仓库名后跟中文标点", () => {
  const r = extractRepos("https://github.com/hank/one，还有 https://github.com/hank/two、plugin 方向！和 https://github.com/hank/three。");
  assert.deepEqual(r.map((x) => x.repo), ["one", "two", "three"]);
});

test("extractMentions: 提及作者", () => {
  assert.deepEqual(extractMentions("感谢 @tianyi 支持，项目 @deepseek 相关"), ["tianyi", "deepseek"]);
});

test("extractGithubIds: 各种中文/英文标识", () => {
  const t = "GitHub id: zhang-san 项目 https://github.com/zhang-san/x";
  assert.deepEqual(extractGithubIds(t), ["zhang-san"]);
  const t2 = "GitHub ID：wangwu5，项目：https://github.com/wangwu5/ui";
  assert.deepEqual(extractGithubIds(t2), ["wangwu5"]);
  const t3 = "gh id: charlie_wang repo: https://github.com/charlie_wang/agg";
  assert.deepEqual(extractGithubIds(t3), ["charlie_wang"]);
  const t4 = "github 用户名: david-lin 项目 https://github.com/david-lin/tools/";
  assert.deepEqual(extractGithubIds(t4), ["david-lin"]);
  const t5 = "GitHub: @grace-yan";
  assert.deepEqual(extractGithubIds(t5), ["grace-yan"]);
  const t6 = "gh：emma_chen，仓库 https://github.com/emma_chen/runtime";
  assert.deepEqual(extractGithubIds(t6), ["emma_chen"]);
  const t7 = "ID: LtyFantasy Proj: Agent Chamber";
  assert.deepEqual(extractGithubIds(t7), ["LtyFantasy"]);
  const t8 = "项目主页 https://github.com/hackdeacon";
  assert.deepEqual(extractGithubIds(t8), ["hackdeacon"]);
});

test("splitReplies: 拆分 jina 风格的 @ 开头块", () => {
  const md = [
    "---",
    "Title: X post",
    "URL Source: https://x.com/tianyi/status/2084693319188439211",
    "---",
    "@tianyi",
    "如果您在做 Agent Harness...",
    "",
    "@zhang-san",
    "GitHub id: zhang-san 项目 https://github.com/zhang-san/mcp",
    "",
    "@wangwu5",
    "https://github.com/wangwu5/ui 支持！",
    "",
  ].join("\n");
  const replies = splitReplies(md, { skipFirst: true });
  assert.equal(replies.length, 2);
  assert.equal(replies[0].author, "zhang-san");
  assert.ok(replies[0].text.includes("github.com/zhang-san"));
});

test("splitReplies: 手动粘贴的纯文本也能拆(带'回复@'前缀)", () => {
  const txt = "回复 @zhang-san: 我来\n回复 @li-si: 项目 https://github.com/li-si/plugin";
  const r = splitReplies(txt);
  assert.equal(r.length, 2);
  assert.equal(r[1].author, "li-si");
});

test("splitReplies: 无 @ 前缀的连续文本合成一块", () => {
  const txt = "第一行内容\n第二行内容";
  const r = splitReplies(txt);
  assert.equal(r.length, 1);
  assert.ok(r[0].text.includes("第二行"));
});

test("parseReplyBlock: 完整字段提取", () => {
  const r = parseReplyBlock("zhang-san", "GitHub id: zhang-san，MCP server，https://github.com/zhang-san/agent-harness-mcp 求关注 @tianyi");
  assert.equal(r.githubIds[0], "zhang-san");
  assert.equal(r.repos[0].owner + "/" + r.repos[0].repo, "zhang-san/agent-harness-mcp");
  assert.deepEqual(r.mentions, ["tianyi"]);
});

test("parseAll: 端到端去重并保留作者", () => {
  const md = [
    "@a",
    "https://github.com/a/project",
    "",
    "@b",
    "https://github.com/a/project 我也做了整合",
    "",
    "@c",
    "GitHub: c_cc 无仓库",
    "",
  ].join("\n");
  const out = parseAll(md);
  assert.equal(out.replies.length, 3);
  const repos = out.repoSet();
  assert.equal(repos.length, 1);
  assert.equal(repos[0].contributors.includes("a"), true);
  assert.equal(repos[0].contributors.includes("b"), true);
});

test("parseAll: 过滤原帖文本", () => {
  const md = `@tianyi\n${POST.text}\n\n@bob\nhttps://github.com/bob/x\n`;
  const out = parseAll(md);
  assert.equal(out.replies.length, 1);
  assert.equal(out.replies[0].author, "bob");
});

test("expandEntities: t.co 短链展开", () => {
  const t = "项目 https://t.co/abc123 求关注";
  const entities = { urls: [{ url: "https://t.co/abc123", expanded_url: "https://github.com/foo/bar" }] };
  assert.equal(expandEntities(t, entities), "项目 https://github.com/foo/bar 求关注");
});

test("parseGuestJson: X 游客 API 会话时间线 JSON", () => {
  const json = {
    data: { thread: [{ conversation_timeline: { entries: [
      { content: { entryType: "TimelineTimelineItem", itemContent: { tweet_results: { result: {
        rest_id: "111", legacy: { id_str: "111", full_text: "GitHub id: bob 项目 https://github.com/bob/agg",
          entities: { urls: [] } },
        core: { user_results: { result: { legacy: { screen_name: "bob" } } } },
      } } } } },
      { content: { entryType: "TimelineTimelineCursor", cursorValue: "abc" } },
      { content: { entryType: "TimelineTimelineItem", itemContent: { tweet_results: { result: {
        rest_id: "112", legacy: { id_str: "112", full_text: "转推内容", retweeted_status_result: {} },
        core: { user_results: { result: { legacy: { screen_name: "rt" } } } },
      } } } } },
    ] } } ] },
  };
  const out = parseGuestJson(json, "2084693319188439211");
  assert.equal(out.length, 1);
  assert.equal(out[0].author, "bob");
  assert.equal(out[0].repos[0].owner + "/" + out[0].repos[0].repo, "bob/agg");
});

test("parseGuestJson: 原帖(根回复)被跳过", () => {
  const json = {
    data: { thread: [{ conversation_timeline: { entries: [
      { content: { entryType: "TimelineTimelineItem", itemContent: { tweet_results: { result: {
        rest_id: "2084693319188439211", legacy: { id_str: "2084693319188439211", full_text: "原帖", entities: { urls: [] } },
        core: { user_results: { result: { legacy: { screen_name: "tianyi" } } } },
      } } } } },
    ] } } ] },
  };
  assert.equal(parseGuestJson(json, "2084693319188439211").length, 0);
});

function pageJson(tweets, cursor) {
  const entries = tweets.map((t) => ({
    content: { entryType: "TimelineTimelineItem", itemContent: { tweet_results: { result: {
      rest_id: t.id, legacy: { id_str: t.id, full_text: t.text, entities: { urls: [] } },
      core: { user_results: { result: { legacy: { screen_name: t.author } } } },
    } } } },
  }));
  if (cursor) entries.push({ content: { entryType: "TimelineTimelineCursor", value: cursor } });
  return { data: { thread: [{ conversation_timeline: { entries } }] } };
}

test("paginateReplies: 沿 cursor 链翻页抓取全部", async () => {
  const pages = [
    pageJson([{ id: "1", author: "a", text: "https://github.com/a/one" }], "cur2"),
    pageJson([{ id: "2", author: "b", text: "https://github.com/b/two" }], "cur3"),
    pageJson([{ id: "3", author: "c", text: "https://github.com/c/three" }], null),
  ];
  let calls = 0;
  const fetchPage = async (cursor) => {
    calls++;
    assert.equal(cursor, calls === 1 ? null : "cur" + calls);
    const p = pages[calls - 1];
    return { json: p, cursor: p.data.thread[0].conversation_timeline.entries.at(-1).content.value ?? null };
  };
  const replies = await paginateReplies(fetchPage, { rootId: "root", delay: 0 });
  assert.equal(calls, 3);
  assert.equal(replies.length, 3);
});

test("paginateReplies: 跨页重复条目去重", async () => {
  const pages = [
    pageJson([{ id: "1", author: "a", text: "https://github.com/a/one" }], "cur2"),
    pageJson([{ id: "1", author: "a", text: "https://github.com/a/one" }, { id: "2", author: "b", text: "https://github.com/b/two" }], null),
  ];
  let i = 0;
  const fetchPage = async () => ({ json: pages[i++], cursor: i === 1 ? "cur2" : null });
  const replies = await paginateReplies(fetchPage, { rootId: "root", delay: 0 });
  assert.equal(replies.length, 2);
});

test("paginateReplies: 连续空页提前停止", async () => {
  let calls = 0;
  const fetchPage = async () => {
    calls++;
    if (calls === 1) return { json: pageJson([{ id: "1", author: "a", text: "hi" }], "cur2"), cursor: "cur2" };
    return { json: pageJson([], null), cursor: null };
  };
  const replies = await paginateReplies(fetchPage, { rootId: "root", delay: 0 });
  assert.equal(replies.length, 1);
  assert.equal(calls, 2);
});

test("paginateReplies: maxPages 上限", async () => {
  let calls = 0;
  const fetchPage = async () => {
    calls++;
    return { json: pageJson([{ id: String(calls), author: "a", text: "x" + calls }], "cur" + calls), cursor: "cur" + calls };
  };
  const replies = await paginateReplies(fetchPage, { rootId: "root", delay: 0, maxPages: 5 });
  assert.equal(calls, 5);
  assert.equal(replies.length, 5);
});

test("paginateReplies: onPage 进度回调", async () => {
  const seen = [];
  const fetchPage = async (c) => c ? { json: pageJson([{ id: "2", author: "b", text: "y" }], null), cursor: null }
    : { json: pageJson([{ id: "1", author: "a", text: "x" }], "c2"), cursor: "c2" };
  await paginateReplies(fetchPage, { rootId: "root", delay: 0, onPage: (n, p) => seen.push([n, p]) });
  assert.deepEqual(seen, [[1, 1], [2, 2]]);
});
