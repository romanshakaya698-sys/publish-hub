/**
 * 平台机器人（独立 headless 通道）
 *
 * 一个平台 = 一个机器人。一个 headless chromium 进程、一个 profile 目录，
 * 同时承担两件事：
 *   1. 自动发稿（被 publisher.js 调用，复用本模块的 context）
 *   2. 状态抓取（每 2 分钟一次，对应原 status-bot 行为）
 *
 * 设计动机：
 *   同一个平台只有一个账号，发稿和抓状态都用同一套登录态，没必要开
 *   两个独立 chromium 实例、两套 cookies。把 status-bot / publisher-bot
 *   合并后：少一个进程、少一份内存、少一次扫码登录。
 *
 * 工作方式：
 *   - profile 目录 = publish-hub/profiles/bot/<platformId>/
 *   - 全自动发稿 / 状态抓取 → headless=true（后台默默跑）
 *   - 预填待确认（confirm 模式）→ headless=false（弹出窗口给用户看操作流程）
 *   - 首次需要扫码登录：调 openLoginWindow 走 headed 窗口，
 *     cookies 落盘后再切回 headless。
 *   - publisher 任务和状态抓取都用 getContext，互不冲突
 *     （各起各的 page、用完就关）。
 */
const path = require('path');
const fs = require('fs');

if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, '..', 'browsers');
}
const { chromium } = require('playwright');
const store = require('./store');

const BOT_PROFILE_DIR = path.join(store.PROFILE_DIR, 'bot');
fs.mkdirSync(BOT_PROFILE_DIR, { recursive: true });

// platformId -> BrowserContext（按 headless 区分缓存 key）
const contexts = new Map();
// platformId -> { loggedIn: boolean, lastCheck: ISO }
const health = new Map();
// articleId -> 公开可分享的 page.om.qq.com 链接（enrichMediaUrl 的 LRU 缓存，避免重复访问 preview 页）
const publicUrlCache = new Map();
const PUBLIC_URL_CACHE_MAX = 500;

const FETCH_TIMEOUT = 60 * 1000;

/**
 * 把 article/preview?articleId=xxx 形式的「作者预览链接」解析为可公开访问的
 * page.om.qq.com/page/xxxxx 链接（用户分享给朋友直接点开的那种）。
 * 解析结果按 articleId 缓存，避免每次状态同步都重复访问 preview 页。
 * 失败时原样返回（preview 链接至少能进作者后台）。
 */
async function enrichMediaUrl(ctx, rawUrl) {
  if (!rawUrl) return rawUrl;
  let articleId = null;
  try {
    const u = new URL(rawUrl);
    if (u.hostname.includes('om.qq.com') && u.pathname.includes('/article/preview')) {
      articleId = u.searchParams.get('articleId');
    }
  } catch {}
  if (!articleId) return rawUrl;
  if (publicUrlCache.has(articleId)) return publicUrlCache.get(articleId);
  const page = await ctx.newPage();
  try {
    await page.goto(rawUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
    let finalUrl = page.url();
    let publicUrl = '';
    if (finalUrl.includes('page.om.qq.com/page/')) {
      publicUrl = finalUrl;
    } else {
      // preview 页可能 JS 渲染后再跳，或者只是 og:url 标签里藏着
      publicUrl = await page.evaluate(() => {
        const m = document.querySelector('meta[property="og:url"]')
          || document.querySelector('meta[name="shareurl"]')
          || document.querySelector('link[rel="canonical"]');
        return m ? (m.getAttribute('content') || m.getAttribute('href') || '') : '';
      });
    }
    if (publicUrl && publicUrl.includes('page.om.qq.com/page/')) {
      if (publicUrlCache.size >= PUBLIC_URL_CACHE_MAX) {
        // 简单 LRU：删最早插入的
        const firstKey = publicUrlCache.keys().next().value;
        publicUrlCache.delete(firstKey);
      }
      publicUrlCache.set(articleId, publicUrl);
      return publicUrl;
    }
    return rawUrl; // 解析不出来就回退 preview
  } catch {
    return rawUrl;
  } finally {
    if (!page.isClosed()) await page.close().catch(() => {});
  }
}

function profileDir(platformId) {
  return path.join(BOT_PROFILE_DIR, platformId);
}

/**
 * 启动 / 复用某平台的机器人 context。
 *
 * 无头/有头规则（用户明确要求）：
 *   - 全自动发稿、后台状态检查 → headless=true（后台默默跑）
 *   - 预填待确认（confirm 模式）→ headless=false（弹出窗口，用户能看着
 *     机器人操作流程、最后自己点「发表」）
 *
 * 注意：同一 profile 目录不能被两个 chromium 实例同时占用，
 * 所以跨模式切换时先关掉另一模式的 context：
 *   - 要有头：先关 headless（后台机器人无用户状态，关了没损失）
 *   - 要无头：若已有可见窗口（confirm 模式留给用户操作的），直接复用
 *     它（新开 tab 抓完就关），不打扰用户窗口
 */
async function getContext(platformId, { headless = true } = {}) {
  const cacheKey = `${platformId}::${headless ? 'h' : 'v'}`;
  if (contexts.has(cacheKey)) {
    const ctx = contexts.get(cacheKey);
    if (!ctx.isClosed?.()) return ctx;
    contexts.delete(cacheKey);
  }
  if (headless) {
    // 已有可见窗口时复用（避免同 profile 双开冲突、不打扰用户操作）
    const visibleKey = `${platformId}::v`;
    if (contexts.has(visibleKey)) {
      const vctx = contexts.get(visibleKey);
      if (!vctx.isClosed?.()) return vctx;
      contexts.delete(visibleKey);
    }
  } else {
    // 要开可见窗口：先关后台 headless，释放 profile
    const hiddenKey = `${platformId}::h`;
    if (contexts.has(hiddenKey)) {
      const hctx = contexts.get(hiddenKey);
      contexts.delete(hiddenKey);
      await hctx.close().catch(() => {});
    }
  }
  const ctx = await chromium.launchPersistentContext(profileDir(platformId), {
    headless,
    viewport: { width: 1440, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  contexts.set(cacheKey, ctx);
  return ctx;
}

/**
 * 快速判断某个平台的机器人是否「已登录」：
 *   - 检测 profile 目录下是否有 Cookies / Local Storage 等登录态痕迹
 *   - 如无，则返回 needsLogin=true
 *
 * 注意：Chromium 首次启动会写内部 cookies，文件大小通常 > 1KB，
 *       所以这个判定是"profile 是否被创建过"的近似，不等于"真的登录了"。
 *       想确认真实登录态请用 probeLogin。
 */
function needsLoginHeuristic(platformId) {
  const dir = profileDir(platformId);
  if (!fs.existsSync(dir)) return true;
  const cookiesPath = path.join(dir, 'Default', 'Cookies');
  if (fs.existsSync(cookiesPath) && fs.statSync(cookiesPath).size > 1000) return false;
  const localStoragePath = path.join(dir, 'Default', 'Local Storage', 'leveldb');
  if (fs.existsSync(localStoragePath)) return false;
  return true;
}

/**
 * 真实测试登录态：拿一个 page 访问 statusUrl / publishUrl 看是否被踢回登录页。
 * 通过 = true，未通过 = false。
 */
async function probeLogin(platform, ctx) {
  const target = platform.statusUrl || platform.publishUrl || platform.loginUrl;
  if (!target) return false;
  const page = await ctx.newPage();
  try {
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    const url = page.url();
    const fragments = platform.loginCheck?.loginUrlFragments || ['login'];
    return !fragments.some((f) => url.includes(f));
  } catch {
    return false;
  } finally {
    if (!page.isClosed()) await page.close().catch(() => {});
  }
}

/**
 * 抓取平台内容管理列表（statusUrl），返回 [{title, status, time}]。
 * status 为平台原文（已发布/审核中/待发布/未通过/草稿 等）。
 *
 * 失败/未登录统一返回 { ok: false, reason }，调用方不要 crash。
 */
async function fetchStatusList(platform) {
  const r = { items: [], ok: false, reason: '' };
  if (!platform.statusUrl) {
    r.reason = 'no-status-url';
    return r;
  }
  const ctx = await getContext(platform.id, { headless: true });
  const page = await ctx.newPage();
  try {
    await page.goto(platform.statusUrl, { waitUntil: 'domcontentloaded', timeout: FETCH_TIMEOUT });
    await page.waitForTimeout(4500);
    const statusKeywords = /^(已发布|审核中|待发布|未通过|草稿|审核失败|审核不通过|发布失败|已下线|已下架)$/;

    // 平台定义了 statusSelectors（如大鱼号）时，按卡片结构精确抓取
    if (platform.statusSelectors && platform.statusSelectors.card) {
      const cards = await page.evaluate((cfg) => {
        const { card: cardSel, title: titleSel, status: statusSel } = cfg;
        const out = [];
        for (const card of [...document.querySelectorAll(cardSel)]) {
          const titleEl = card.querySelector(titleSel);
          const statusEl = card.querySelector(statusSel);
          if (!titleEl) continue;
          const title = (titleEl.innerText || '').trim().slice(0, 90);
          const status = (statusEl ? statusEl.innerText : '').trim();
          const timeMatch = (card.innerText || '').match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
          // 卡片内第一个有效链接（大鱼号卡片通常无公开链接，则留空由用户手填）
          let url = '';
          const linkEl = card.querySelector('a[href]');
          if (linkEl) {
            const h = (linkEl.href || '').trim();
            if (h && !h.startsWith('javascript:') && h !== '#' && !h.endsWith('#')) url = h;
          }
          out.push({ title, status, time: timeMatch ? timeMatch[0] : '', url });
        }
        return out;
      }, platform.statusSelectors);
      r.items = cards;
      r.ok = true;
      health.set(platform.id, { loggedIn: true, lastCheck: new Date().toISOString(), itemCount: cards.length });
      return r;
    }

    const cards = await page.evaluate((kwSrc) => {
      const re = new RegExp(kwSrc);
      const out = [];
      for (const st of [...document.querySelectorAll('[class*="greyitem"]')]) {
        const statusText = (st.innerText || '').trim();
        if (!re.test(statusText)) continue;
        let card = st;
        for (let i = 0; i < 8; i++) {
          card = card.parentElement;
          if (!card) break;
          if ((card.innerText || '').trim().length > 40) break;
        }
        if (!card) continue;
        const cardText = (card.innerText || '').trim();
        const titleEl = card.querySelector('a[href*="article"], [class*="title"], h3, h2, [class*="name"]') || card;
        const title = (titleEl.innerText || titleEl.textContent || '').trim().slice(0, 90);
        // 提取媒体链接：优先匹配「公开可分享」的特征关键词（点开不需登录），
        // 否则退回标题元素或卡片内第一个有效链接。
        // 以后新平台只需扩充 PUBLIC_URL_KEYWORDS 数组。
        const PUBLIC_URL_KEYWORDS = ['page.om.qq.com/page/'];
        let url = '';
        const allLinks = card.querySelectorAll('a[href]');
        for (const kw of PUBLIC_URL_KEYWORDS) {
          for (const a of allLinks) {
            const raw = a.getAttribute('href') || '';
            if (raw.includes(kw)) { url = a.href; break; }
          }
          if (url) break;
        }
        if (!url) {
          const linkEl = titleEl.tagName === 'A' ? titleEl : (card.querySelector('a[href*="article"]') || card.querySelector('a[href]'));
          if (linkEl) {
            const h = (linkEl.href || '').trim();
            if (h && !h.startsWith('javascript:') && h !== '#' && !h.endsWith('#')) url = h;
          }
        }
        const timeMatch = cardText.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
        out.push({ title, status: statusText, time: timeMatch ? timeMatch[0] : '', url });
      }
      return out;
    }, statusKeywords.source);
    // 把 preview 形式链接 enrich 为 page.om.qq.com 公开链接（顺序处理，缓存避免重复访问）
    for (const it of cards) {
      if (it.url) it.url = await enrichMediaUrl(ctx, it.url);
    }
    r.items = cards;
    r.ok = true;
    health.set(platform.id, { loggedIn: true, lastCheck: new Date().toISOString(), itemCount: cards.length });
  } catch (e) {
    r.reason = e.message;
    try {
      const url = page.url();
      const fragments = platform.loginCheck?.loginUrlFragments || ['login'];
      if (fragments.some((f) => url.includes(f))) {
        health.set(platform.id, { loggedIn: false, lastCheck: new Date().toISOString() });
      }
    } catch {}
  } finally {
    if (!page.isClosed()) await page.close().catch(() => {});
  }
  return r;
}

/**
 * 把机器人切到 headless=false、打开登录页，等用户完成登录后
 * 把 context 关闭，下次默认 headless 即可识别登录态。
 *
 * 由 /api/bot/login/:platformId 调用。
 */
async function openLoginWindow(platform, { onLog } = {}) {
  await closeContext(platform.id, { headless: true });
  const ctx = await getContext(platform.id, { headless: false });
  const page = await ctx.newPage();
  await page.goto(platform.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  onLog?.(`已为 ${platform.name} 机器人打开登录窗口，请在弹出/可见的窗口中扫码登录`);

  const fragments = platform.loginCheck?.loginUrlFragments || ['login'];
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    if (page.isClosed()) {
      onLog?.('用户关闭了登录窗口');
      return { loggedIn: false, closed: true };
    }
    const url = page.url();
    if (!fragments.some((f) => url.includes(f))) {
      onLog?.(`检测到已进入后台（${url}），机器人登录成功`);
      try { if (!page.isClosed()) await page.close(); } catch {}
      await closeContext(platform.id, { headless: false });
      health.set(platform.id, { loggedIn: true, lastCheck: new Date().toISOString() });
      return { loggedIn: true, url };
    }
  }
  onLog?.('等待登录超时（10 分钟）');
  return { loggedIn: false, timeout: true };
}

async function closeContext(platformId, { headless = true } = {}) {
  const cacheKey = `${platformId}::${headless ? 'h' : 'v'}`;
  const ctx = contexts.get(cacheKey);
  if (ctx && !ctx.isClosed?.()) await ctx.close().catch(() => {});
  contexts.delete(cacheKey);
}

async function closeAll() {
  for (const [k, ctx] of contexts) {
    if (!ctx.isClosed?.()) await ctx.close().catch(() => {});
  }
  contexts.clear();
}

function listBotHealth() {
  const out = {};
  for (const [pid, h] of health) out[pid] = h;
  return out;
}

module.exports = {
  getContext,
  openLoginWindow,
  probeLogin,
  needsLoginHeuristic,
  fetchStatusList,
  closeContext,
  closeAll,
  listBotHealth,
  profileDir,
};