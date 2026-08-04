# 📡 报名雷达 (x-replies-search)

抓取 X(Twitter)帖子下的报名/征集回复,用正则提取 **GitHub 项目直链、GitHub ID、相关者昵称**,前台风格化展示 + 搜索,用于及时发现**自己熟悉的人**是否参与了报名。

当前目标帖: [@tianyi · DeepSeek Harness (DSH) 开源项目接入征集](https://x.com/tianyi/status/2084693319188439211)(136 条回复)

线上地址: <https://yabo083.github.io/x-replies-search/>

## 功能

- **多来源抓取**:r.jina.ai 渲染 → X 游客 API → 手动粘贴(纯静态站无后端,所有抓取都在浏览器内完成)
- **正则解析**:GitHub 直链(https/www/git@ssh 形式、剥除 `#fragment`、`?query`、`/tree/` 子路径)、`GitHub id:` / `gh:` / `github 用户名:` 等标识、`@提及`
- **GitHub API 富化**:仓库描述、⭐、语言、许可证、更新时间(按需加载 + 本地缓存,规避匿名限额 60 次/时)
- **熟人雷达**:维护自己的熟人名单(GitHub ID),命中条目金色高亮,一键"只看熟人"
- **统计**:语言分布、累计星数、项目数、回复数
- **搜索**:仓库名/作者/GitHub ID/描述即时过滤

## 部署

纯静态站,推送到 GitHub 即可启用 Pages:

```bash
git push origin main
gh api -X POST /repos/<owner>/<repo>/pages -f "source[branch]=main" -f "source[path]=/"
```

## 换目标帖

改 `app.js` 顶部的 `CONFIG`(screenName / tweetId / fallbackMeta 文案)。

## 开发

```bash
npm test        # 解析器单测(node:test)
python -m http.server 8811   # 本地预览
```

## 目录

```
parser.js   纯函数解析器(浏览器 + node 双端可用)
app.js      抓取 / 富化 / 渲染 / 搜索 / 熟人
index.html  页面结构
style.css   深色主题
data/sample-replies.txt  样例数据(可粘贴体验)
test/       单测
```
