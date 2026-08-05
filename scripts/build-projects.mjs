import { readFile, writeFile } from "node:fs/promises";
import { parseReplyBlock } from "../parser.js";

const token = process.env.GITHUB_TOKEN;
if (!token) throw new Error("GITHUB_TOKEN is required");

const snapshot = JSON.parse(await readFile("data/replies.json", "utf8"));
const projects = new Map();

for (const raw of snapshot.replies) {
  const reply = parseReplyBlock(raw.author || "", raw.text || "");
  for (const repo of reply.repos) {
    const key = `${repo.owner}/${repo.repo}`.toLowerCase();
    if (!projects.has(key)) {
      projects.set(key, {
        key,
        owner: repo.owner,
        repo: repo.repo,
        fullName: `${repo.owner}/${repo.repo}`,
        url: `https://github.com/${repo.owner}/${repo.repo}`,
        xUsers: new Set(),
        githubIds: new Set([repo.owner]),
        replyIds: [],
        excerpts: [],
      });
    }
    const item = projects.get(key);
    if (raw.author) item.xUsers.add(raw.author);
    for (const id of reply.githubIds) item.githubIds.add(id);
    if (raw.id) item.replyIds.push(String(raw.id));
    if (item.excerpts.length < 3) item.excerpts.push(raw.text.slice(0, 280));
  }
}

const items = [...projects.values()];

function escapeGraphql(value) {
  return JSON.stringify(value);
}

for (let offset = 0; offset < items.length; offset += 50) {
  const batch = items.slice(offset, offset + 50);
  const fields = batch.map((item, index) => `
    r${index}: repository(owner: ${escapeGraphql(item.owner)}, name: ${escapeGraphql(item.repo)}) {
      nameWithOwner
      url
      description
      stargazerCount
      isArchived
      pushedAt
      owner { login avatarUrl url }
      primaryLanguage { name color }
      licenseInfo { spdxId }
    }`).join("\n");
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "x-replies-search-builder",
    },
    body: JSON.stringify({ query: `query { ${fields} }` }),
  });
  if (!response.ok) throw new Error(`GitHub GraphQL HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.errors?.length) console.warn(payload.errors.map((error) => error.message).join("; "));
  batch.forEach((item, index) => {
    const repo = payload.data?.[`r${index}`];
    item.github = repo ? {
      fullName: repo.nameWithOwner,
      url: repo.url,
      description: repo.description,
      stars: repo.stargazerCount,
      archived: repo.isArchived,
      pushedAt: repo.pushedAt,
      owner: repo.owner,
      language: repo.primaryLanguage,
      license: repo.licenseInfo?.spdxId || null,
    } : null;
  });
}

const normalized = items.map((item) => ({
  key: item.key,
  owner: item.owner,
  repo: item.repo,
  fullName: item.github?.fullName || item.fullName,
  url: item.github?.url || item.url,
  description: item.github?.description || null,
  stars: item.github?.stars ?? null,
  language: item.github?.language || null,
  archived: item.github?.archived || false,
  pushedAt: item.github?.pushedAt || null,
  license: item.github?.license || null,
  avatarUrl: item.github?.owner?.avatarUrl || null,
  available: Boolean(item.github),
  xUsers: [...item.xUsers].sort((a, b) => a.localeCompare(b)),
  githubIds: [...item.githubIds].sort((a, b) => a.localeCompare(b)),
  replyIds: [...new Set(item.replyIds)],
  excerpts: item.excerpts,
})).sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1) || a.fullName.localeCompare(b.fullName));

const languages = {};
for (const item of normalized) {
  if (item.language?.name) languages[item.language.name] = (languages[item.language.name] || 0) + 1;
}

const output = {
  generatedAt: new Date().toISOString(),
  sourceFetchedAt: snapshot.fetchedAt,
  sourceReplyCount: snapshot.replies.length,
  sourceAuthorCount: snapshot.summary?.authors || new Set(snapshot.replies.map((reply) => reply.author)).size,
  projectCount: normalized.length,
  availableProjectCount: normalized.filter((item) => item.available).length,
  totalStars: normalized.reduce((sum, item) => sum + (item.stars || 0), 0),
  languages,
  projects: normalized,
};

await writeFile("data/projects.json", JSON.stringify(output, null, 2) + "\n", "utf8");
console.log(`Built ${output.projectCount} projects from ${output.sourceReplyCount} replies`);
