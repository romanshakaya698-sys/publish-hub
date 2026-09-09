/**
 * 一次性探测网易号 v4 后台发文页 DOM（用完即删）
 * 探测目标：
 *   1) 发文页路由（hash）
 *   2) 标题输入控件
 *   3) 正文编辑器（UEditor iframe 还是 contenteditable）
 *   4) 栏目分类下拉结构
 *   5) 封面上传控件
 *   6) 发布按钮文案与 class
 *   7) 内容管理列表页（状态抓取用）的卡片结构
 */
const path = require('path');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, '..', 'browsers');
}
const { chromium } = require('playwright');

const profileDir = path.join(__dirname, '..', 'profiles', 'bot', 'netease');

async function dump(label, page) {
  const url = page.url();
  console.log('\n========== ' + label + ' ==========');
  console.log('URL:', url);
  // 抓 hash 路由
  const hash = await page.evaluate(() => location.hash);
  console.log('hash:', hash);
  const title = await page.title();
  console.log('title:', title);
}

async function probeEditor(page) {
  // 标题候选
  const titleSelectors = [
    'input[placeholder*="标题"]',
    'textarea[placeholder*="标题"]',
    '.title-input textarea',
    '.title-input input',
    '.editor-title input',
    '.editor-title textarea',
    'input#title',
    '[contenteditable="true"][placeholder*="标题"]',
    '.post-title input',
    '.post-title textarea',
    '.post-title [contenteditable]',
  ];
  for (const sel of titleSelectors) {
    const found = await page.locator(sel).count();
    if (found > 0) {
      const html = await page.locator(sel).first().evaluate(el => el.outerHTML.slice(0, 200));
      console.log(`  title[${sel}] count=${found} html=${html}`);
    }
  }

  // 正文候选（iframe 优先）
  const iframeInfo = await page.evaluate(() => {
    const iframes = [...document.querySelectorAll('iframe')].map(f => ({
      id: f.id || '',
      name: f.name || '',
      src: f.src || '',
      cls: f.className || '',
    }));
    return iframes;
  });
  console.log('  iframes:', JSON.stringify(iframeInfo, null, 2));

  const contentSelectors = [
    '.ProseMirror[contenteditable="true"]',
    '[contenteditable="true"]',
    '.editor-content',
    '.post-content',
    '.article-content',
    '.edui-body',
    '.edui-body iframe',
  ];
  for (const sel of contentSelectors) {
    const found = await page.locator(sel).count();
    if (found > 0) {
      console.log(`  content[${sel}] count=${found}`);
    }
  }

  // 栏目分类下拉
  const dropdownSelectors = [
    '.ant-select',
    '.ant-select-selector',
    '[class*="select"]',
    '[class*="dropdown"]',
    '[class*="category"]',
    '[class*="column"]',
  ];
  for (const sel of dropdownSelectors) {
    const found = await page.locator(sel).count();
    if (found > 0) {
      const html = await page.locator(sel).first().evaluate(el => el.outerHTML.slice(0, 300));
      console.log(`  dropdown[${sel}] count=${found} html=${html}`);
    }
  }

  // 封面上传
  const fileInputs = await page.evaluate(() => {
    return [...document.querySelectorAll('input[type="file"]')].map(f => ({
      accept: f.accept || '',
      name: f.name || '',
      cls: f.className || '',
      parent: f.parentElement ? f.parentElement.outerHTML.slice(0, 200) : '',
    }));
  });
  console.log('  file inputs:', JSON.stringify(fileInputs, null, 2));

  // 发布按钮
  const btnSelectors = [
    'button:has-text("发布")',
    'button:has-text("发表")',
    'button:has-text("保存")',
    '.btn-publish',
    '[class*="publish"]',
    '[class*="submit"]',
  ];
  for (const sel of btnSelectors) {
    try {
      const found = await page.locator(sel).count();
      if (found > 0) {
        const text = await page.locator(sel).first().innerText().catch(() => '');
        console.log(`  btn[${sel}] count=${found} text="${text}"`);
      }
    } catch {}
  }
}

(async () => {
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();

  // 1) 进 v4 后台主页
  await page.goto('http://mp.163.com/subscribe_v4/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);
  await dump('v4 主页', page);

  // 抓所有 a[href]，看发文页路由
  const links = await page.evaluate(() => {
    return [...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href')).filter(Boolean);
  });
  console.log('a[href] (前 30):', links.slice(0, 30));

  // 抓菜单/导航
  const navTexts = await page.evaluate(() => {
    return [...document.querySelectorAll('nav a, .nav a, .menu a, .sidebar a, [class*="nav"] a, [class*="menu"] a')]
      .map(a => ({ text: (a.innerText || '').trim().slice(0, 30), href: a.getAttribute('href') || '' }))
      .filter(x => x.text);
  });
  console.log('nav links:', JSON.stringify(navTexts.slice(0, 30), null, 2));

  // 2) 直接试 hash 路由 /post-editor
  await page.goto('http://mp.163.com/subscribe_v4/index.html#/post-editor', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);
  await dump('post-editor 路由', page);
  await probeEditor(page);

  // 截图
  await page.screenshot({ path: 'probe-netease-editor.png', fullPage: true });
  console.log('screenshot saved: probe-netease-editor.png');

  // 3) 内容管理列表
  await page.goto('http://mp.163.com/subscribe_v4/index.html#/post-list', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);
  await dump('post-list 路由', page);

  const listCards = await page.evaluate(() => {
    // 抓所有看起来像卡片的元素
    const candidates = [...document.querySelectorAll('[class*="list-item"], [class*="post-item"], [class*="article-item"], [class*="content-item"], [class*="card"], [class*="row"]')];
    const samples = [];
    for (const el of candidates.slice(0, 5)) {
      samples.push({
        cls: el.className || '',
        text: (el.innerText || '').trim().slice(0, 200),
      });
    }
    return { count: candidates.length, samples };
  });
  console.log('list cards:', JSON.stringify(listCards, null, 2));

  await page.screenshot({ path: 'probe-netease-list.png', fullPage: true });
  console.log('screenshot saved: probe-netease-list.png');

  await ctx.close();
})();
