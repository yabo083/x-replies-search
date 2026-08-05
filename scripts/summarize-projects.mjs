import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const baseUrl = (process.env.LLM_BASE_URL || "https://moyuu.cc/v1").replace(/\/$/, "");
const apiKey = process.env.LLM_API_KEY;
const models = (process.env.LLM_MODELS || process.env.LLM_MODEL || "gpt-5.6-luna,gpt-5.6-sol")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
let activeModel = models[0];
const cachePath = "data/summaries.json";
const projectsPath = "data/projects.json";
const maxPending = Number.parseInt(process.env.LLM_MAX_PENDING || "40", 10);

if (!apiKey) throw new Error("LLM_API_KEY is required");

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

function signature(project) {
  return createHash("sha256").update(JSON.stringify({
    fullName: project.fullName,
    description: project.description,
    language: project.language?.name,
    xUsers: project.xUsers,
    githubIds: project.githubIds,
    excerpts: project.excerpts,
  })).digest("hex");
}

function promptProjects(batch) {
  return batch.map((project) => ({
    key: project.key,
    repository: project.fullName,
    applicants: project.xUsers,
    relatedGithubUsers: project.githubIds,
    githubDescription: project.description,
    language: project.language?.name || null,
    signupReplies: project.excerpts,
  }));
}

function parseContent(content) {
  const text = Array.isArray(content)
    ? content.map((item) => item.text || item.content || "").join("")
    : String(content || "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Model did not return a JSON object");
  return JSON.parse(text.slice(start, end + 1));
}

async function summarizeWithModel(batch, selectedModel) {
  const system = [
    "你是一个克制、准确的开源项目目录编辑。",
    "请根据报名用户、实际 GitHub 仓库资料与报名回复，为每个项目写一句中文摘要。",
    "每句必须包含 X 报名用户和 owner/repo 仓库名，控制在 35-80 个中文字符，不写 Markdown。",
    "描述项目实际用途，不复述 Star 数，不添加资料中没有的能力，不使用夸张宣传语。",
    "若有多个报名人，写主要报名人并用“等”概括。",
    "只返回 JSON 对象，键必须与输入 key 完全一致，值为摘要字符串。",
  ].join("\n");
  const body = {
    model: selectedModel,
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(promptProjects(batch)) },
    ],
    temperature: 0.2,
  };

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 240);
        const error = new Error(`LLM HTTP ${response.status}: ${detail}`);
        error.channelUnavailable = detail.includes("get_channel_failed") || detail.includes("可用渠道不存在");
        throw error;
      }
      const payload = await response.json();
      return parseContent(payload.choices?.[0]?.message?.content);
    } catch (error) {
      lastError = error;
      if (error.channelUnavailable) break;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

async function summarize(batch) {
  const candidates = [activeModel, ...models.filter((model) => model !== activeModel)];
  let lastError;
  for (const candidate of candidates) {
    try {
      const result = await summarizeWithModel(batch, candidate);
      if (candidate !== activeModel) console.log(`Switched summary model to ${candidate}`);
      activeModel = candidate;
      return result;
    } catch (error) {
      lastError = error;
      if (!error.channelUnavailable) throw error;
      console.warn(`Summary model unavailable: ${candidate}`);
    }
  }
  throw lastError;
}

const catalog = await readJson(projectsPath, null);
if (!catalog?.projects) throw new Error("data/projects.json is missing or invalid");
const cache = await readJson(cachePath, { model: activeModel, updatedAt: null, items: {} });
cache.items ||= {};

const pending = catalog.projects.filter((project) => {
  const item = cache.items[project.key];
  return !item || item.signature !== signature(project) || !item.summary;
});
const work = pending.slice(0, Number.isFinite(maxPending) && maxPending > 0 ? maxPending : 40);

let generated = 0;
for (let offset = 0; offset < work.length; offset += 10) {
  const batch = work.slice(offset, offset + 10);
  try {
    const result = await summarize(batch);
    for (const project of batch) {
      const summary = typeof result[project.key] === "string" ? result[project.key].trim() : "";
      if (summary.length < 12 || summary.length > 220) continue;
      cache.items[project.key] = {
        signature: signature(project),
        summary,
        generatedAt: new Date().toISOString(),
      };
      generated++;
    }
    console.log(`Summarized ${Math.min(offset + batch.length, work.length)} / ${work.length} this run (${pending.length} pending)`);
  } catch (error) {
    console.warn(`Summary batch failed: ${error.message}`);
    break;
  }
}

const activeKeys = new Set(catalog.projects.map((project) => project.key));
cache.items = Object.fromEntries(Object.entries(cache.items).filter(([key]) => activeKeys.has(key)));
cache.model = activeModel;
cache.updatedAt = new Date().toISOString();

for (const project of catalog.projects) {
  project.aiSummary = cache.items[project.key]?.summary || null;
}
catalog.summaryModel = activeModel;
catalog.summaryGeneratedAt = cache.updatedAt;

await writeFile(cachePath, JSON.stringify(cache, null, 2) + "\n", "utf8");
await writeFile(projectsPath, JSON.stringify(catalog, null, 2) + "\n", "utf8");
console.log(`Generated ${generated}; reused ${catalog.projects.length - pending.length}; available ${catalog.projects.filter((project) => project.aiSummary).length}`);
if (work.length > 0 && generated === 0) throw new Error("No pending project summaries were generated");
