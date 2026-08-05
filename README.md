# DSH Open Source Index

整理 [@tianyi 的 DeepSeek Harness 开源项目征集帖](https://x.com/tianyi/status/2084693319188439211)，将回复中的报名人、GitHub 项目和相关者生成按 Star 排序的静态目录。

线上地址：<https://yabo083.github.io/x-replies-search/>

## 数据链路

1. `root@bren9np` 每小时运行 `scripts/update-replies.py`。
2. 脚本使用 twscrape `tweet_thread` 抓取整个 conversation；无计数变化时立即退出。
3. 有变化时轻量扫描并按 tweet ID 增量合并，只展开新回复里的 t.co 短链；每日执行一次完整校准且只增不删。
4. 服务器推送 `data/replies.json` 后，GitHub Actions 运行 `scripts/build-projects.mjs`。
5. Actions 使用 GitHub GraphQL API 批量补齐描述、Stars、语言、头像和更新时间，生成 `data/projects.json`。
6. GitHub Pages 前端只读取 `projects.json`，不在浏览器内访问 X 或 GitHub API。

## 本地开发

```bash
npm test
GITHUB_TOKEN="$(gh auth token)" npm run build:data
python -m http.server 8820
```

## 增量抓取

```bash
TWS_PROXY=http://127.0.0.1:7890 \
TWS_DB=/root/accounts.db \
PYTHONPATH=/root/.local/share/uv/tools/twscrape/lib/python3.12/site-packages \
python3 scripts/update-replies.py
```

完整校准：

```bash
python3 scripts/update-replies.py --full
```

## 主要文件

```text
data/replies.json             X 会话增量快照
data/projects.json            GitHub 富化后的前端目录
scripts/update-replies.py     服务器增量抓取器
scripts/build-projects.mjs    GitHub 项目目录构建器
parser.js                     GitHub URL / ID 解析器
app.js                        纯静态目录渲染和搜索
```
