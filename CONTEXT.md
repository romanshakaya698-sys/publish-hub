# PublishHub 项目上下文交接文档

> 本文档是给「下一个上下文（新会话）」的完整交接。读完即可无断点继续开发。
> 最后更新：2026-09-08 20:48

---

## 一、这是什么项目

**PublishHub** —— 自媒体多平台一键发稿工具（Node.js + Express + Playwright）。

核心功能：上传 Word/Markdown 稿件 → 前端配置各平台的额外字段（分类/标签/声明等）→ 机器人 headless chromium 自动打开发文页、填表、点发布 → 每 2 分钟自动抓平台内容管理页跟进审核状态 → 回填文章公开链接。

- **部署形态**：纯本地，跑在用户 Mac 上，端口 **3789**，访问 `http://localhost:3789`
- **已跑通平台**：企鹅号（腾讯内容开放平台 om.qq.com），端到端全自动
- **未实现**：网易号（platforms.js 里有定义，发稿逻辑未写）

---

## 二、目录结构（关键文件）

```
publish-hub/
├── server.js            # Express 主入口，全部 API 端点 + 2分钟定时同步
├── lib/
│   ├── bot.js           # ⭐ 核心：统一机器人（headless chromium 通道）
│   ├── publisher.js     # ⭐ 核心：发稿流程（填表/点发布/状态同步/链接回填）
│   ├── platforms.js     # 平台定义（id/name/site/publishUrl/statusUrl/字段配置）
│   ├── browser.js       # 旧的用户 headed Chrome 通道（发稿已不用，保留兜底）
│   ├── doc-parser.js    # Word/MD 稿件解析
│   └── store.js         # JSON 文件存储
├── public/
│   ├── index.html       # 4 个 tab：稿件库/发布记录/账号管理/📊发布总览
│   ├── app.js           # 前端全部逻辑（无框架，原生 JS）
│   └── style.css
├── data/
│   ├── articles.json    # 稿件库
│   ├── records.json     # 发布记录（含 publishStatus/mediaUrl）
│   ├── settings.json    # 平台配置
│   └── uploads/         # 上传的稿件文件/封面
├── profiles/            # ⭐ Playwright 持久化登录态（每目录一套独立 cookie）
│   ├── bot/qq/          # 机器人用（发稿+抓状态共用）← 现在只用这个
│   ├── qq/              # 旧：用户 headed Chrome 登录态（已不用）
│   ├── status-bot/      # 旧：已合并进 bot，可删
│   ├── publisher-bot/   # 旧：已合并进 bot，可删
│   └── netease/
└── browsers/            # playwright chromium 下载目录
```

---

## 三、核心架构：三通道演进史（重要！）

### 最终形态（当前）

```
企鹅号 ──┬── 用户 headed Chrome（lib/browser.js）
        │    profiles/qq/          ← 仅剩手动登录兜底，前端已不调用
        │
        └── 🤖 统一机器人（lib/bot.js，headless）
             profiles/bot/qq/      ← 发稿 + 抓状态 + 链接回填 全走这里
             │
             ├─ 发稿任务：newPage → 填表 → 点发布 → close
             └─ 状态抓取：newPage → 读内容管理列表 → close（每2分钟）
```

**演进过程**（避免下个上下文重蹈覆辙）：
1. 最初：publisher 直接用用户 headed Chrome → **用户强烈反对**（"不要在我电脑屏幕跟前做"）
2. 拆成 status-bot + publisher-bot 两个独立 headless → 用户指出**同一平台一个机器人就够**（"企鹅号只能登一个机器人，能不能弄成一个做发稿也做检测"）
3. 最终合并为单一 `lib/bot.js`，一套 profile `profiles/bot/<platformId>/`，发稿和抓状态共用一个 BrowserContext（各开各的 page，不冲突）

### bot.js 关键 API

```js
const { bot } = require('./lib/bot');
await bot.getContext(platformId)          // 取/建持久化 headless context（缓存）
await bot.fetchStatusList(platform)       // 抓内容管理页 → { ok, items:[{title,status,time,url}] }
await bot.openLoginWindow(platform, {onLog}) // 首次扫码：临时 headed 弹窗，扫完自动回 headless
await bot.probeLogin(platform, ctx)       // 登录态探针（打开发文页看是否被踢到登录页）
bot.needsLoginHeuristic(platformId)       // 启发式判断（cookie 目录大小，不太准，别太信）
bot.listBotHealth() / bot.profileDir(id) / bot.close()
```

注意：`ctx.pages()` 是**同步方法**（返回数组不是 Promise），这里踩过坑。

---

## 四、发稿流程（lib/publisher.js，企鹅号专用）

企鹅号组件库是 **omui**，全是自定义组件（不是原生 select/radio），选择器均为实战探测得出：

| 步骤 | 要点 |
|------|------|
| 打开发文页 | `https://om.qq.com/main/creation/article` |
| 填标题 | 普通 input |
| 填正文 | 富文本，图片注入 `display:block;margin:0 auto;max-width:100%` 居中 |
| 选分类 | **虚拟列表**：DOM 只渲染前 9 项 → 走"路径0"：从输入框向上找祖先里 `span.omui-tag` 文本===value 的"常用分类"芯片直接点 |
| 填标签 | omui 输入框 + 回车 |
| 选声明（内容自主说明）| omui 弹窗 `omui-dialog-wrapper.open`，选项**精确文本匹配** `innerText.trim() === value`（不能用包含匹配，"无需标注"会被错配成"AI生成"）；选完必须点弹窗底部 `omui-button--primary` 文本"确认"，且轮询弹窗消失 + evaluate 原生 click 兜底 |
| 找发布按钮 | 在固定底部工具栏 `footer.tool-cls2hjrE.publish_tool-cls1mQ0e`；querySelector 可能失败 → `findPublishBtn` 用节点遍历找 `innerText.trim()==='发布'`，scrollIntoView + 蓝框高亮 |

**铁律（用户钉死的）**：企鹅号的 selector/组件逻辑**仅适用于企鹅号**。其他平台（网易号等）组件库完全不同，**必须重新探测 DOM，绝对不能照抄这套思路**。

### 状态码映射（PLATFORM_STATUS）

平台文案 → 内部状态：
- 审核中 → `auditing`
- 已发布 → `published`
- 待发布 → `scheduled`
- 未通过 → `rejected`
- 已下线 → `offline`
- 草稿 → `draft`

### 状态同步链路

```
server.js setInterval 每2分钟（statusBotSyncTick）
  └─ publisher.syncRecordStatus(record)
       └─ bot.fetchStatusList(platform)          # headless 抓内容管理页
            items: [{title, status, time, url}]
       └─ matchByTitle(本地标题, items)            # 标题前缀匹配
       └─ 命中 → 回写 entry.publishStatus / publishStatusAt / mediaUrl
```

### 媒体链接（mediaUrl）——当前未完结的问题

- 内容管理页卡片能抓到 `https://om.qq.com/article/preview?articleId=xxx`（作者预览链接）
- 用户要的是 **`https://page.om.qq.com/page/xxx` 公开可点链接**
- 已做 enrich 尝试：机器人访问 preview 页找 og:url/canonical/跳转 → **失败**，因为稿件审核中平台还没分配公开 ID
- **结论**：page.om.qq.com 链接要等审核通过（published 状态）后才可能出现，届时机器人下次同步或许能直接抓到
- 回填规则（publisher.js syncRecordStatus）：`hit.url` 存在且（entry.mediaUrl 为空 或 新 url 是 page.om.qq.com 形式 或 手动填的）才覆盖；preview 链接不覆盖用户手动填的 page 链接
- **手动兜底**：`PUT /api/records/:id/:platformId/media-url` + 前端总览表格 ✏️ 按钮，用户可自己粘贴 page 链接

---

## 五、API 端点速查（server.js）

### 业务
| 方法 | 路径 | 用途 |
|------|------|------|
| POST | `/api/articles/upload` | 上传稿件（multer） |
| GET/PUT/DELETE | `/api/articles/:id` | 稿件 CRUD |
| POST | `/api/articles/:id/cover` | 上传封面 |
| POST | `/api/publish` | 发起发布任务（articleId + platforms + extra 字段） |
| GET | `/api/records` / `/api/records/:id` | 发布记录（含日志） |
| POST | `/api/records/:id/status` | 手动触发一次状态同步 |
| PUT | `/api/records/:id/:platform/media-url` | 手动填写媒体链接 |
| GET | `/api/platforms` / PUT `/api/platforms/:id` | 平台配置（发文页地址等） |

### 机器人（统一）
| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/bot/status` | 各平台机器人健康度 |
| POST | `/api/bot/login/:pid` | 弹出一次性 headed 扫码登录 |
| POST | `/api/bot/probe-login/:pid` | headless 探针：打开发文页看登录态 |
| POST | `/api/bot/probe-status/:pid` | 测试一次状态抓取 |

### 旧通道（走 lib/browser.js 用户 headed，前端已不调用，留作兜底）
`/api/accounts/:id/login`、`/api/accounts/:id/login-status`、`/api/accounts/:id/check`

### Debug 端点（探测企鹅号 DOM 时加的，很有用）
`/api/debug/elements/:id`、`/api/debug/extra/:id`、`/api/debug/run-extra/:id`、`/api/debug/dump-dialog/:id`、`/api/debug/cover/:id`、`/api/debug/category/:id`、`/api/debug/publishbtn/:id`、`/api/debug/status/:id`、`/api/debug/status-list/:id`
→ 新平台开发时**照这个模式加新的 debug 端点**，先 dump DOM 再写选择器。

---

## 六、前端（public/）

- 无框架，原生 JS + innerHTML 模板
- **4 个 tab**：稿件库 / 发布记录 / 账号管理 / 📊 发布总览
- **📊 发布总览**（最新）：表格 = 每行一条「稿件×平台」，列：媒体/标题/日期/发布时间/发布状态/媒体链接
  - `KEEP_STATUS = {running, success, failed}` 只显示这三种（用户要求过滤掉 pending/confirm）
  - 媒体链接直接显示完整 URL 文本（用户要求，如 `https://www.sohu.com/a/xxx`），可点开
  - ✏️ 按钮手动填链接（prompt 弹窗）
  - 5 秒轮询刷新
- **账号管理**卡片（精简后）：发文页地址输入框 + [保存发文页地址] + 🤖 机器人一行（[扫码登录][测登录][测抓取]）
  - 已删掉「打开登录窗口」「检查登录态」按钮（headed 通道冗余）
- **extra 字段收集**（踩过大坑）：`#pub-extra input, #pub-extra textarea, #pub-extra select` —— **select 必须在列**，否则分类/声明收集不到

---

## 七、数据结构

### records.json 一条记录
```json
{
  "id": "...", "articleId": "...", "articleTitle": "...",
  "createdAt": "ISO",
  "platforms": [{
    "platformId": "qq", "name": "企鹅号",
    "status": "success",              // 本地任务状态: pending/confirm/running/success/failed
    "logs": ["..."],
    "publishStatus": "auditing",      // 平台侧: auditing/published/rejected/scheduled/offline/draft
    "publishStatusAt": "ISO",
    "mediaUrl": "https://..."         // 平台文章链接
  }]
}
```

---

## 八、运行与运维

```bash
cd publish-hub
node server.js          # 或 npm start，端口 3789
```

- 重启套路：`lsof -ti :3789 | xargs kill -9 2>/dev/null; sleep 1; cd <目录> && node server.js`（后台跑）
- **改 public/ 下文件**（前端）不用重启，express.static 每次读磁盘 → 用户浏览器 `Cmd+Shift+R` 即可
- **改 lib/ 或 server.js 必须重启**
- **每次改完 JS 必须 `node --check <file>` 校验语法**（吃过亏：app.js 丢了一个函数声明头 → 顶层 await → SyntaxError → 整页点不了）

### 用户当前状态（2026-09-08 晚）
- 机器人已扫码登录（profiles/bot/qq）
- 已成功自动发布 1 篇《6款主流GEO监控工具横向对比》，审核中
- 该记录 mediaUrl 目前是 preview 链接，等审核通过后看 bot 能否抓到 page.om.qq.com

---

## 九、待办 / 已知问题

1. **【验证中】page.om.qq.com 公开链接回填**——稿件审核通过后，下次 2 分钟同步看内容管理页卡片是否会给出 page 形式链接；如果仍只有 preview，需要研究已发布状态下平台哪里暴露公开链接
2. **网易号开发**——platforms.js 已定义，但发稿逻辑零（记得：不能照抄企鹅号 selector，重新 dump DOM）
3. `profiles/status-bot/`、`profiles/publisher-bot/` 是历史遗留目录，可删（确认无引用后）
4. server.js 的 `/api/accounts/:id/login` 等旧端点 + lib/browser.js——用户点头后可整体清掉
5. `needsLoginHeuristic`（按 cookie 文件大小判断）不准，可改成 probeLogin 真探

## 十、用户偏好（重要）

- **任何 Playwright 操作不能弹到用户桌面**——全部走 headless 机器人；仅"首次扫码登录"允许一次性弹 headed
- 同一平台一个机器人搞定所有事，不要拆多个
- UI 要简洁：冗余按钮直接删（"感觉和机器人的已经重复了"→ 删）
- 表格只看运行中/成功/失败三种状态
- 链接要直接可点的完整 URL 文本
- 语言：中文交流，代码注释也中文
