/**
 * 验证网易号 v4 后台是否对 headless 反爬（headed 对比）
 * 结论用来看：网易号 auto(全自动/headless) 模式是否能用。
 */
const path = require('path');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, '..', 'browsers');
}
const { chromium } = require('playwright');

const profileDir = path.join(__dirname, '..', 'profiles', 'bot', 'netease');
const headless = process.argv[2] !== 'headed';

(async () => {
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless,
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();
  await page.goto('https://mp.163.com/subscribe_v4/index.html#/post-editor', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);
  console.log('headless=' + headless);
  console.log('final URL:', page.url());
  console.log('navigator.webdriver:', await page.evaluate(() => navigator.webdriver));
  await page.screenshot({ path: `probe-netease-${headless ? 'hd' : 'headed'}.png`, fullPage: true });
  console.log('screenshot: probe-netease-' + (headless ? 'hd' : 'headed') + '.png');
  if (!headless) await page.waitForTimeout(8000); // headed 让它停一会儿给用户看
  await ctx.close();
})();
