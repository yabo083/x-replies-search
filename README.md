# 📡 报名雷达 (x-replies-search)

抓取 X(Twitter)帖子下的报名/征集回复,用正则提取 **GitHub 项目直链、GitHub ID、相关者昵称**,前台风格化展示 + 搜索,用于及时发现**自己熟悉的人**是否参与了报名。

当前目标帖: [@tianyi · DeepSeek Harness (DSH) 开源项目接入征集](https://x.com/tianyi/status/2084693319188439211)(136 条回复)

线上地址: <https://yabo083.github.io/x-replies-search/>

## 功能

- **翻页抓取全部回复**:X 游客 API(guest token + conversation timeline)沿 cursor 逐页抓取直到翻完,多代理轮换、token 失效自动重试、跨页去重;失败时降级 r.jina.ai 渲染 → 手动粘贴
- **抓取完整度**:进度条实时显示「已抓 N / 帖子显示 M 条」,判断是否漏数据
- **正则解析**:GitHub 直链(https/www/git@ssh 形式、剥除 `#fragment`、`?query`、`/tree/` 子路径)、`GitHub id:` / `gh:` / `github 用户名:` 等标识、`@提及`
- **GitHub API 富化**:仓库描述、⭐、语言、许可证、更新时间(按需加载 + 本地缓存,规避匿名限额 60 次/时)
- **熟人雷达(核心)**:维护熟人名单后,命中者置顶显示在金色横幅——直接列出每位熟人的名字与其参与的项目,一键"只看熟人"
- **重点分层**:热门项目(⭐ Top3)🔥 标记置顶、排序(星数/参与人数/名称)、语言分布、熟人统计卡高亮
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
