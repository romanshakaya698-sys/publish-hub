/**
 * 深入网易号发文页：
 *  - 正文编辑器结构（contenteditable 外层 class、是否 ProseMirror）
 *  - 封面 radio 组结构与默认选中
 *  - 发布按钮 class
 *  - 分类/栏目下拉（如有）
 *  - 声明/AI 标注控件
 *  - 实测：填标题、点正文、看工具栏
 */
const path = require('path');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, '..', 'browsers');
}
const { chromium } = require('playwright');

const profileDir = path.join(__dirname, '..', 'profiles', 'bot', 'netease');

(async () => {
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: false, viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();
  await page.goto('https://mp.163.com/subscribe_v4/index.html#/article-publish', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(10000);
  console.log('URL after load:', page.url());

  // 正文编辑器结构
  const ed = await page.evaluate(() => {
    const ce = document.querySelector('[contenteditable="true"]');
    if (!ce) return 'NO contenteditable';
    let up = ce, chain = [];
    for (let i = 0; i < 6 && up; i++) { chain.push(up.tagName + '.' + (up.className || '')); up = up.parentElement; }
    return { tag: ce.tagName, cls: ce.className, id: ce.id || '', chain };
  });
  console.log('正文编辑器:', JSON.stringify(ed, null, 2));

  // 封面 radio 结构
  const covers = await page.evaluate(() => {
    const out = [];
    for (const label of [...document.querySelectorAll('label, [class*="radio"], [class*="cover"]')]) {
      const t = (label.innerText || '').trim();
      if (t && t.length <= 8 && ['三图', '单图', '大图', '自动'].includes(t)) {
        out.push({ text: t, cls: label.className || '', html: label.outerHTML.slice(0, 220) });
      }
    }
    return out;
  });
  console.log('封面 radio:', JSON.stringify(covers, null, 2));

  // 上传图片按钮
  const up = await page.evaluate(() => {
    const out = [];
    for (const el of [...document.querySelectorAll('button, span, div, [class*="upload"], [class*="add"]')]) {
      const t = (el.innerText || '').trim();
      if (t === '上传图片' || t === '添加图片') out.push({ tag: el.tagName, cls: el.className || '', text: t, html: el.outerHTML.slice(0, 250) });
    }
    return out;
  });
  console.log('上传图片按钮:', JSON.stringify(up, null, 2));

  // 发布按钮
  const pub = await page.evaluate(() => {
    for (const b of [...document.querySelectorAll('button, a, [class*="btn"]')]) {
      const t = (b.innerText || '').trim();
      if (t === '发布') return { tag: b.tagName, cls: b.className || '', html: b.outerHTML.slice(0, 250) };
    }
    return null;
  });
  console.log('发布按钮:', JSON.stringify(pub, null, 2));

  // 声明/AI标注
  const decl = await page.evaluate(() => {
    const out = [];
    for (const el of [...document.querySelectorAll('label, [class*="check"], [class*="switch"], [class*="declar"], [class*="statement"]')]) {
      const t = (el.innerText || '').trim();
      if (t && t.length < 40 && /声明|AI|标注|原创|转载|自动|生成/.test(t)) {
        out.push({ text: t, cls: el.className || '' });
      }
    }
    return out;
  });
  console.log('声明/标注:', JSON.stringify(decl.slice(0, 20), null, 2));

  // 分类下拉
  const cat = await page.evaluate(() => {
    // 找 placeholder 含"分类"或"栏目"或"请选择"
    const out = [];
    for (const inp of [...document.querySelectorAll('input, textarea')]) {
      const p = inp.placeholder || '';
      if (/分类|栏目|领域|请选择/.test(p)) out.push({ tag: inp.tagName, placeholder: p, cls: inp.className || '' });
    }
    return out;
  });
  console.log('分类输入:', JSON.stringify(cat, null, 2));

  // 实测：填标题
  const title = page.locator('textarea.netease-textarea[placeholder*="标题"]');
  await title.click();
  await title.fill('网易号实测标题：从功能到性价比，6款主流GEO监控工具横向对比与选型建议');
  console.log('标题已填:', await title.inputValue());

  await page.screenshot({ path: 'probe-netease-publish2.png', fullPage: true });
  console.log('screenshot: probe-netease-publish2.png');
  await page.waitForTimeout(1500);
  await ctx.close();
})();
