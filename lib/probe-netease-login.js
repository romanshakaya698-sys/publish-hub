/**
 * 长驻网易号登录窗口（用户扫码登录用）
 * 打开登录页并一直保持，直到：
 *   - 页面 URL 脱离 login 页（检测到登录成功）
 *   - 或被手动关闭
 * 成功后输出 LOGGED_IN 并退出；失败输出 TIMEOUT。
 * 注意：不依赖 server，直接 headed 打开。
 */
const path = require('path');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, '..', 'browsers');
}
const { chromium } = require('playwright');

const profileDir = path.join(__dirname, '..', 'profiles', 'bot', 'netease');
const LOGIN_URL = 'https://mp.163.com/login.html';

(async () => {
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();
  // 直接带回去地址打开登录页：登录成功后会自动跳回复原地址
  const returnUrl = encodeURIComponent('https://mp.163.com/subscribe_v4/index.html#/article-publish');
  await page.goto(`${LOGIN_URL}?url=${returnUrl}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('登录窗口已打开:', page.url());
  console.log('请在可见窗口中扫码登录，登录成功后我会自动检测到（最长等 10 分钟）');

  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    if (page.isClosed()) { console.log('用户关闭了登录窗口'); await ctx.close(); process.exit(2); }
    const url = page.url();
    if (!url.includes('login') && !url.includes('passport')) {
      console.log('LOGGED_IN url=' + url);
      await page.waitForTimeout(1500);
      await ctx.close();
      process.exit(0);
    }
  }
  console.log('TIMEOUT');
  await ctx.close();
  process.exit(1);
})();
