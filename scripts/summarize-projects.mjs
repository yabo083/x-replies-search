import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const baseUrl = (process.env.LLM_BASE_URL || "https://moyuu.cc/v1").replace(/\/$/, "");
const apiKey = process.env.LLM_API_KEY;
const model = process.env.LLM_MODEL || "gpt-5.6-luna";
const cachePath = "data/summaries.json";
const projectsPath = "data/projects.json";

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

async function summarize(batch) {
  const system = [
    "你是一个克制、准确的开源项目目录编辑。",
    "请根据报名用户、实际 GitHub 仓库资料与报名回复，为每个项目写一句中文摘要。",
    "每句必须包含 X 报名用户和 owner/repo 仓库名，控制在 35-80 个中文字符，不写 Markdown。",
    "描述项目实际用途，不复述 Star 数，不添加资料中没有的能力，不使用夸张宣传语。",
    "若有多个报名人，写主要报名人并用“等”概括。",
    "只返回 JSON 对象，键必须与输入 key 完全一致，值为摘要字符串。",
  ].join("\n");
  const body = {
    model,
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
      if (!response.ok) throw new Error(`LLM HTTP ${response.status}: ${(await response.text()).slice(0, 240)}`);
      const payload = await response.json();
      return parseContent(payload.choices?.[0]?.message?.content);
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

const catalog = await readJson(projectsPath, null);
if (!catalog?.projects) throw new Error("data/projects.json is missing or invalid");
const cache = await readJson(cachePath, { model, updatedAt: null, items: {} });
cache.items ||= {};

const pending = catalog.projects.filter((project) => {
  const item = cache.items[project.key];
  return !item || item.signature !== signature(project) || !item.summary;
});

let generated = 0;
for (let offset = 0; offset < pending.length; offset += 10) {
  const batch = pending.slice(offset, offset + 10);
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
    console.log(`Summarized ${Math.min(offset + batch.length, pending.length)} / ${pending.length}`);
  } catch (error) {
    console.warn(`Summary batch failed: ${error.message}`);
  }
}

const activeKeys = new Set(catalog.projects.map((project) => project.key));
cache.items = Object.fromEntries(Object.entries(cache.items).filter(([key]) => activeKeys.has(key)));
cache.model = model;
cache.updatedAt = new Date().toISOString();

for (const project of catalog.projects) {
  project.aiSummary = cache.items[project.key]?.summary || null;
}
catalog.summaryModel = model;
catalog.summaryGeneratedAt = cache.updatedAt;

await writeFile(cachePath, JSON.stringify(cache, null, 2) + "\n", "utf8");
await writeFile(projectsPath, JSON.stringify(catalog, null, 2) + "\n", "utf8");
console.log(`Generated ${generated}; reused ${catalog.projects.length - pending.length}; available ${catalog.projects.filter((project) => project.aiSummary).length}`);
