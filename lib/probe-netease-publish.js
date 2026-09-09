/**
 * headed 打开网易号真实发文路由 #/article-publish，dump 编辑器 DOM。
 */
const path = require('path');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, '..', 'browsers');
}
const { chromium } = require('playwright');

const profileDir = path.join(__dirname, '..', 'profiles', 'bot', 'netease');

async function probe(page) {
  // 1) 标题控件
  const titleSelectors = [
    'input[placeholder*="标题"]', 'textarea[placeholder*="标题"]',
    '.title-input input', '.title-input textarea', '.title-input [contenteditable]',
    '.editor-title input', '.editor-title textarea',
    '[placeholder*="标题"]', 'input#title',
  ];
  for (const sel of titleSelectors) {
    let cnt = 0;
    try { cnt = await page.locator(sel).count(); } catch {}
    if (cnt > 0) {
      const html = await page.locator(sel).first().evaluate(el => el.outerHTML.slice(0, 250)).catch(() => '');
      console.log(`  title[${sel}] count=${cnt}\n    ${html}`);
    }
  }

  // 2) iframe 正文
  const iframes = await page.evaluate(() => [...document.querySelectorAll('iframe')].map(f => ({
    id: f.id || '', name: f.name || '', src: (f.src || '').slice(0, 120), cls: f.className || '',
  })));
  console.log('  iframes:', JSON.stringify(iframes, null, 2));

  // 3) contenteditable
  console.log('  [contenteditable]:', await page.locator('[contenteditable="true"]').count());

  // 4) 封面上传 input
  const fits = await page.evaluate(() => [...document.querySelectorAll('input[type="file"]')].map(f => ({
    accept: f.accept || '', name: f.name || '', cls: f.className || '',
    parent: (f.parentElement ? f.parentElement.outerHTML : '').slice(0, 200),
  })));
  console.log('  file inputs:', JSON.stringify(fits, null, 2));

  // 5) 发布按钮
  const btnTexts = await page.evaluate(() => {
    const out = [];
    for (const b of [...document.querySelectorAll('button, .btn, [class*="publish"], [class*="submit"], [class*="confirm"]')]) {
      const t = (b.innerText || '').trim();
      if (t && t.length < 12) out.push(t);
    }
    return [...new Set(out)];
  });
  console.log('  按钮文本:', btnTexts);

  // 6) 分类下拉
  const down = await page.evaluate(() => {
    const sels = ['.ant-select', '.ant-select-selector', '[class*="suggest"]', '[class*="category"]', '[class*="column"]', '[class*="select"]'];
    return sels.map(s => ({ s, n: document.querySelectorAll(s).length }));
  });
  console.log('  下拉候选:', JSON.stringify(down));
}

(async () => {
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: false, viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();
  await page.goto('https://mp.163.com/subscribe_v4/index.html#/article-publish', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);
  console.log('URL:', page.url());
  await probe(page);
  await page.screenshot({ path: 'probe-netease-publish.png', fullPage: true });
  console.log('screenshot: probe-netease-publish.png');
  await page.waitForTimeout(2000);
  await ctx.close();
})();
