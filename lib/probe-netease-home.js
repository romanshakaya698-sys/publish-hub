/**
 * headed 模式下抓网易号 v4 后台导航路由，找「发文/发布文章」入口。
 * 保持打开一段时间让 DOM dump 完；最后抓正文编辑相关元素。
 */
const path = require('path');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, '..', 'browsers');
}
const { chromium } = require('playwright');

const profileDir = path.join(__dirname, '..', 'profiles', 'bot', 'netease');

(async () => {
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();
  await page.goto('https://mp.163.com/subscribe_v4/index.html#/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);
  console.log('URL:', page.url());

  // 抓所有导航/菜单链接（含带 hash 的）
  const nav = await page.evaluate(() => {
    const out = [];
    for (const a of [...document.querySelectorAll('a[href]')]) {
      const href = a.getAttribute('href') || '';
      const text = (a.innerText || '').trim().slice(0, 20);
      if (text) out.push({ text, href });
    }
    // 也抓 span/i 里可能的路由（React 路由常挂在 div 的 onclick/data 上，抓不到就算了）
    return out;
  });
  const hashLinks = nav.filter(x => x.href.includes('#'));
  console.log('hash 路由链接:', JSON.stringify(hashLinks, null, 2));
  console.log('全部导航 links:', JSON.stringify(nav.slice(0, 40), null, 2));

  // 抓页面里可见的文本（概览）
  const bodyText = await page.evaluate(() => (document.body.innerText || '').slice(0, 1500));
  console.log('body 文本:', bodyText);

  await page.screenshot({ path: 'probe-netease-home.png', fullPage: true });
  console.log('screenshot: probe-netease-home.png');
  await page.waitForTimeout(4000);
  await ctx.close();
})();
