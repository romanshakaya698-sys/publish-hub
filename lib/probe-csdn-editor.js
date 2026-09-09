/**
 * CSDN 发文页深度探测（headless，profile 已登录）
 * 目标：标题输入、Markdown 编辑器、发布按钮、文章分类、标签、封面等
 */
const path = require('path');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, '..', 'browsers');
}
const { chromium } = require('playwright');

const profileDir = path.join(__dirname, '..', 'profiles', 'bot', 'csdn');

(async () => {
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: true, viewport: { width: 1440, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = await ctx.newPage();
  await page.goto('https://editor.csdn.net/md/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);
  console.log('URL:', page.url());

  // 1) 标题
  const titleInputs = await page.evaluate(() => {
    const out = [];
    for (const el of [...document.querySelectorAll('input, textarea')]) {
      const p = el.placeholder || el.value || '';
      if (/标题|无标题/.test(p)) out.push({ tag: el.tagName, placeholder: p, cls: el.className || '', id: el.id || '' });
    }
    return out;
  });
  console.log('标题候选:', JSON.stringify(titleInputs, null, 2));

  // 2) 内容编辑器
  const editor = await page.evaluate(() => {
    const ce = document.querySelector('.editor-content, .CodeMirror, .monaco-editor, [contenteditable], textarea[id*="editor"], #contentText');
    return {
      ce: !!ce,
      cls: ce ? ce.className : '',
      tag: ce ? ce.tagName : '',
      ceCount: document.querySelectorAll('[contenteditable]').length,
      taCount: document.querySelectorAll('textarea').length,
    };
  });
  console.log('内容编辑器:', JSON.stringify(editor, null, 2));

  // 3) 工具栏按钮（粗体/标题/图片/链接/代码块等）
  const toolbar = await page.evaluate(() =>
    [...document.querySelectorAll('button, [class*="toolbar"] button, [class*="tool"]')]
      .map((b) => (b.innerText || b.title || '').trim())
      .filter((t) => t && t.length < 12)
      .slice(0, 50)
  );
  console.log('工具栏:', JSON.stringify(toolbar));

  // 4) 发布按钮 + 右侧面板
  const sideBtns = await page.evaluate(() => {
    const out = [];
    for (const b of [...document.querySelectorAll('button, a')]) {
      const t = (b.innerText || '').trim();
      if (t && t.length < 12 && /发布|保存|草稿|预览|取消/.test(t)) out.push({ text: t, cls: b.className || '', html: b.outerHTML.slice(0, 200) });
    }
    return out;
  });
  console.log('操作按钮:', JSON.stringify(sideBtns, null, 2));

  // 5) 文章设置面板（分类、标签、封面等）
  const sidebar = await page.evaluate(() => {
    const out = [];
    // 抓右侧栏里所有 label、placeholder、tab
    for (const el of [...document.querySelectorAll('[class*="setting"], [class*="form"] input, [class*="form"] textarea, [class*="form"] select, label')]) {
      const t = (el.innerText || el.placeholder || '').trim();
      if (t && t.length < 20) out.push({ tag: el.tagName, cls: (el.className || '').slice(0, 80), text: t, ph: el.placeholder || '' });
    }
    return out.slice(0, 40);
  });
  console.log('设置面板:', JSON.stringify(sidebar, null, 2));

  // 6) 抓上传封面 input
  const fileInputs = await page.evaluate(() =>
    [...document.querySelectorAll('input[type="file"]')].map((f) => ({
      accept: f.accept || '', name: f.name || '', cls: f.className || '',
      parent: (f.parentElement ? f.parentElement.outerHTML : '').slice(0, 200),
    }))
  );
  console.log('file inputs:', JSON.stringify(fileInputs, null, 2));

  // 截图
  await page.screenshot({ path: 'probe-csdn-editor.png', fullPage: true });
  console.log('screenshot: probe-csdn-editor.png');

  // 7) 点开文章设置抽屉（如果有「文章设置」按钮）
  const settingsBtn = page.locator('button:has-text("文章设置"), button:has-text("设置"), .article-settings').first();
  if (await settingsBtn.count()) {
    try {
      await settingsBtn.click({ force: true });
      await page.waitForTimeout(1500);
      const more = await page.evaluate(() => {
        const out = [];
        for (const el of [...document.querySelectorAll('input, select, textarea, [class*="tag"], [class*="cover"]')]) {
          const t = (el.innerText || el.placeholder || el.getAttribute('placeholder') || '').trim();
          const cls = (el.className || '').slice(0, 80);
          if (t && t.length < 30) out.push({ tag: el.tagName, cls, text: t, ph: el.placeholder || '' });
        }
        return out.slice(0, 50);
      });
      console.log('设置面板展开后:', JSON.stringify(more, null, 2));
      await page.screenshot({ path: 'probe-csdn-settings.png', fullPage: true });
    } catch {}
  }

  await ctx.close();
})();
