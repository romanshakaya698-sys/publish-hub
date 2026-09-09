/**
 * 知乎创作者中心发文页探测（headless，profile 已登录）
 * 目标：找到真正的发文路由（不是 /publish，那是 404），dump 编辑器 DOM
 */
const path = require('path');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, '..', 'browsers');
}
const { chromium } = require('playwright');

const profileDir = path.join(__dirname, '..', 'profiles', 'bot', 'zhihu');

(async () => {
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: true, viewport: { width: 1440, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = await ctx.newPage();
  // 创作者中心首页（已登录会进后台）
  await page.goto('https://www.zhihu.com/creator', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);
  console.log('creator 首页 URL:', page.url());

  // 抓所有 hash/internal 路由链接，找「写文章/发文章/专栏」入口
  const links = await page.evaluate(() =>
    [...document.querySelectorAll('a[href]')]
      .map((a) => ({ text: (a.innerText || '').trim().slice(0, 30), href: a.getAttribute('href') || '' }))
      .filter((x) => /文章|发布|写|publish|column|creator/i.test(x.text + ' ' + x.href))
  );
  console.log('相关链接:');
  for (const l of links) console.log(' ', l.text, '→', l.href);

  // 直接试常见路由
  const candidates = [
    'https://zhuanlan.zhihu.com/write',
    'https://zhuanlan.zhihu.com/p/new',
    'https://www.zhihu.com/creator/article/new',
    'https://zhuanlan.zhihu.com/editor',
  ];
  for (const url of candidates) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    const t = await page.title();
    const hasTitle = await page.locator('input[placeholder*="标题"], textarea[placeholder*="标题"]').count();
    console.log(`  ${url} → title="${t}" hasTitleInput=${hasTitle}`);
  }

  // 在知乎首页找「写文章」入口
  await page.goto('https://www.zhihu.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);
  const writeBtn = await page.evaluate(() => {
    const candidates = [...document.querySelectorAll('button, a, [class*="write"], [class*="publish"]')];
    for (const el of candidates) {
      const t = (el.innerText || '').trim();
      if (/^(写文章|写专栏|发布文章|创作)$/.test(t)) return { text: t, cls: el.className || '', html: el.outerHTML.slice(0, 200) };
    }
    return null;
  });
  console.log('首页「写文章」入口:', JSON.stringify(writeBtn, null, 2));

  await ctx.close();
})();
