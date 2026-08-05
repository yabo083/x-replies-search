const state = {
  data: null,
  query: "",
  language: "",
};

const $ = (id) => document.getElementById(id);
const rows = $("projectRows");
const catalogState = $("catalogState");

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(value || 0);
}

function formatTime(value) {
  if (!value) return "更新时间未知";
  return `数据更新于 ${new Date(value).toLocaleString("zh-CN", { hour12: false })}`;
}

function uniqueCaseInsensitive(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function identities(values, kind) {
  if (!values.length) return '<span class="identity-empty">-</span>';
  return values.slice(0, 4).map((value) => {
    const url = kind === "x" ? `https://x.com/${encodeURIComponent(value)}` : `https://github.com/${encodeURIComponent(value)}`;
    const prefix = kind === "x" ? "X @" : "GH ";
    return `<a class="identity" href="${url}" target="_blank" rel="noopener" title="${escapeHtml(value)}">${prefix}${escapeHtml(value)}</a>`;
  }).join("");
}

function row(project, index) {
  const language = project.language?.name || "-";
  const languageColor = project.language?.color || "#999999";
  const related = uniqueCaseInsensitive(project.githubIds.filter((id) => id.toLowerCase() !== project.owner.toLowerCase()));
  const avatar = project.avatarUrl
    ? `<img class="project-avatar" src="${escapeHtml(project.avatarUrl)}" alt="" loading="lazy" />`
    : `<span class="project-avatar avatar-fallback">${escapeHtml(project.owner.slice(0, 2).toUpperCase())}</span>`;
  const description = project.aiSummary || project.description || "GitHub 暂无项目描述";
  const summaryBadge = project.aiSummary ? '<span class="summary-badge">AI</span>' : "";
  return `
    <article class="project-row">
      <div class="project-rank ${index < 3 ? "top" : ""}">${String(index + 1).padStart(2, "0")}</div>
      <div class="project-main">
        ${avatar}
        <div class="project-copy">
          <a class="project-name" href="${escapeHtml(project.url)}" target="_blank" rel="noopener">${escapeHtml(project.fullName)}</a>
          <div class="project-description" title="${escapeHtml(description)}">${summaryBadge}${escapeHtml(description)}</div>
        </div>
      </div>
      <div class="project-stars">★ ${project.stars == null ? "-" : formatNumber(project.stars)}</div>
      <div class="project-language"><span class="language-dot" style="background:${escapeHtml(languageColor)}"></span>${escapeHtml(language)}</div>
      <div class="identity-list project-applicants">${identities(project.xUsers, "x")}</div>
      <div class="identity-list project-related">${identities(related, "github")}</div>
      <a class="project-link" href="${escapeHtml(project.url)}" target="_blank" rel="noopener" aria-label="打开 ${escapeHtml(project.fullName)}">↗</a>
    </article>`;
}

function filteredProjects() {
  const query = state.query.toLowerCase();
  return state.data.projects.filter((project) => {
    if (state.language && project.language?.name !== state.language) return false;
    if (!query) return true;
    const haystack = [
      project.fullName,
      project.description || "",
      ...(project.xUsers || []),
      ...(project.githubIds || []),
      project.language?.name || "",
    ].join(" ").toLowerCase();
    return haystack.includes(query);
  });
}

function render() {
  if (!state.data) return;
  const projects = filteredProjects();
  rows.innerHTML = projects.map(row).join("");
  catalogState.hidden = projects.length > 0;
  catalogState.textContent = state.query || state.language ? "没有匹配的项目" : "暂无项目数据";
  $("resultCount").textContent = `${projects.length} / ${state.data.projectCount}`;
}

async function loadCatalog() {
  try {
    const response = await fetch("data/projects.json", { cache: "no-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = await response.json();
    state.data.projects.sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1) || a.fullName.localeCompare(b.fullName));

    $("replyCount").textContent = formatNumber(state.data.sourceReplyCount);
    $("projectCount").textContent = formatNumber(state.data.projectCount);
    const people = new Set(state.data.projects.flatMap((project) => [...project.xUsers, ...project.githubIds].map((value) => value.toLowerCase())));
    $("peopleCount").textContent = formatNumber(people.size);
    $("starCount").textContent = formatNumber(state.data.totalStars);
    $("updatedAt").textContent = formatTime(state.data.sourceFetchedAt || state.data.generatedAt);

    const languages = Object.entries(state.data.languages).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    $("languageFilter").insertAdjacentHTML("beforeend", languages.map(([name, count]) =>
      `<option value="${escapeHtml(name)}">${escapeHtml(name)} (${count})</option>`).join(""));
    render();
  } catch (error) {
    catalogState.hidden = false;
    catalogState.textContent = `项目目录加载失败: ${error.message}`;
  }
}

$("searchInput").addEventListener("input", (event) => {
  state.query = event.target.value.trim();
  render();
});

$("languageFilter").addEventListener("change", (event) => {
  state.language = event.target.value;
  render();
});

loadCatalog();
