/**
 * Playwright 浏览器管理
 * - 每个平台一个独立的持久化 profile（profiles/<id>/），cookie / localStorage 自动保存
 * - 登录窗口：有头浏览器，用户扫码/输密码，登录态写入 profile
 * - 发布：复用同一 profile 的 context
 */
const path = require('path');

// 使用项目内浏览器内核（browsers/），保证 npm start 无需额外配置
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, '..', 'browsers');
}

const { chromium } = require('playwright');
const store = require('./store');

const contexts = new Map(); // platformId -> BrowserContext

function profileDir(platformId) {
  return path.join(store.PROFILE_DIR, platformId);
}

async function getContext(platformId) {
  if (contexts.has(platformId)) {
    const ctx = contexts.get(platformId);
    if (!ctx.isClosed?.()) return ctx;
    contexts.delete(platformId);
  }
  const ctx = await chromium.launchPersistentContext(profileDir(platformId), {
    headless: false, // 有头模式：平台风控更宽松，且用户可扫码登录
    viewport: { width: 1440, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  contexts.set(platformId, ctx);
  return ctx;
}

/**
 * 打开登录窗口：跳到平台登录页，等待用户手动完成登录。
 * 检测到 URL 离开登录页（进入后台）即认为登录成功。
 */
async function openLoginWindow(platform, { onLog, onSuccess }) {
  const ctx = await getContext(platform.id);
  const page = await ctx.newPage();
  await page.goto(platform.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  onLog?.(`已打开 ${platform.name} 登录页，请在浏览器窗口中完成登录`);

  const fragments = platform.loginCheck?.loginUrlFragments || ['login'];
  const deadline = Date.now() + 10 * 60 * 1000; // 10 分钟超时
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    if (page.isClosed()) {
      onLog?.('浏览器窗口已关闭');
      return { loggedIn: false, closed: true };
    }
    const url = page.url();
    const onLoginPage = fragments.some((f) => url.includes(f));
    if (!onLoginPage) {
      onLog?.(`检测到已进入后台（${url}），登录成功，登录态已保存到本地`);
      onSuccess?.(url);
      return { loggedIn: true, url };
    }
  }
  onLog?.('等待登录超时（10 分钟），可稍后重试');
  return { loggedIn: false, timeout: true };
}

/**
 * 检查登录态：新开页面访问发文页，看是否被重定向到登录页
 */
async function checkLogin(platform, publishUrl) {
  const ctx = await getContext(platform.id);
  const page = await ctx.newPage();
  try {
    const target = publishUrl || platform.loginUrl;
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2500);
    const url = page.url();
    const fragments = platform.loginCheck?.loginUrlFragments || ['login'];
    const onLoginPage = fragments.some((f) => url.includes(f));
    return { loggedIn: !onLoginPage, currentUrl: url };
  } catch (e) {
    return { loggedIn: false, currentUrl: page.url(), error: e.message };
  } finally {
    // 检查完不关 context（保留登录态与窗口），只关页面
    if (!page.isClosed()) await page.close().catch(() => {});
  }
}

function isContextOpen(platformId) {
  const ctx = contexts.get(platformId);
  return !!ctx && !ctx.isClosed?.();
}

module.exports = { getContext, openLoginWindow, checkLogin, isContextOpen };
