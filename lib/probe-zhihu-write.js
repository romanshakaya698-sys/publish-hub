/**
 * 知乎 zhuanlan.zhihu.com/write 发文页深度探测（headless，profile 已登录）
 * 目标：标题输入框结构、正文编辑器（ProseMirror？）、发布按钮、封面、话题标签等
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
  await page.goto('https://zhuanlan.zhihu.com/write', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);
  console.log('URL:', page.url());

  // 标题：知乎是 contenteditable 的 div.ArticleTitle
  const titleCandidates = await page.evaluate(() => {
    const out = [];
    for (const el of [...document.querySelectorAll('input, textarea, [contenteditable]')]) {
      const ph = el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '';
      const cls = (el.className || '').toString().slice(0, 90);
      out.push({ tag: el.tagName, cls, ph, editable: el.getAttribute('contenteditable') });
    }
    return out;
  });
  console.log('标题/contenteditable 候选:');
  for (const c of titleCandidates) console.log(' ', JSON.stringify(c));

  // 正文编辑器
  const editor = await page.evaluate(() => {
    const d = document.querySelector('.DraftEditor-root, .public-DraftEditor-content, .RichText, [class*="editor"]');
    return {
      draftEditor: !!document.querySelector('.DraftEditor-root'),
      publicContent: !!document.querySelector('.public-DraftEditor-content'),
      richText: !!document.querySelector('.RichText'),
      cls: d ? d.className : '',
    };
  });
  console.log('正文编辑器:', JSON.stringify(editor, null, 2));

  // 底部按钮
  const btns = await page.evaluate(() => {
    const out = [];
    for (const b of [...document.querySelectorAll('button, a')]) {
      const t = (b.innerText || '').trim();
      if (t && t.length < 16 && /发布|保存|草稿|预览|话题|设置/.test(t)) out.push({ text: t, cls: (b.className || '').toString().slice(0, 80) });
    }
    return out;
  });
  console.log('操作按钮:', JSON.stringify(btns, null, 2));

  // 广播/话题
  const covers = await page.evaluate(() => {
    const out = [];
    for (const el of [...document.querySelectorAll('[class*="cover"], [class*="Cover"], [class*="upload"]')]) {
      const t = (el.innerText || el.title || '').trim();
      if (t && t.length < 20) out.push({ cls: (el.className || '').toString().slice(0, 80), text: t });
    }
    return out.slice(0, 20);
  });
  console.log('封面/上传候选:', JSON.stringify(covers, null, 2));

  // 页面标题
  console.log('page title:', await page.title());

  await page.screenshot({ path: 'probe-zhihu-write.png', fullPage: true });
  console.log('screenshot: probe-zhihu-write.png');
  await ctx.close();
})();
