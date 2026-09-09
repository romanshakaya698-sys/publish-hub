/**
 * CSDN 发布流程有头探测（headless:false，复用已登录 csdn profile，不触发登录）
 * 目标：
 *  1) 标题框真实选择器（placeholder「请输入文章标题」）
 *  2) 正文 Markdown 源码区是否已被 htmlToMarkdown 填入
 *  3) 「发布文章」按钮位置
 *  4) 点「发布文章」后进入的发布设置页 DOM（封面/标签/分类/原创声明等）
 * 只抓结构，自动关闭，不人工操作。
 */
const path = require('path');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, '..', 'browsers');
}
const { chromium } = require('playwright');

const profileDir = path.join(__dirname, '..', 'profiles', 'bot', 'csdn');

(async () => {
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1600, height: 950 },
    args: ['--disable-blink-features=AutomationControlled', '--window-position=60,60'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const url = process.env.CSDN_URL || 'https://editor.csdn.net/md/';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(7000);
  console.log('URL:', page.url());

  // 1) 标题框：所有 input / textarea，带 placeholder + class
  const titleCands = await page.evaluate(() => {
    const out = [];
    for (const el of [...document.querySelectorAll('input, textarea')]) {
      const ph = el.placeholder || '';
      const cls = (el.className || '').toString();
      const isTitle = /标题/.test(ph) || /标题/.test(cls) || /title/i.test(cls);
      if (isTitle) out.push({ tag: el.tagName, ph, cls: cls.slice(0, 90), id: el.id || '', visible: el.offsetParent !== null });
    }
    return out;
  });
  console.log('标题候选:', JSON.stringify(titleCands, null, 2));

  // 2) 正文源码区 textarea / contenteditable（先看当前值）
  const bodyCands = await page.evaluate(() => {
    const out = [];
    for (const el of [...document.querySelectorAll('textarea, [contenteditable="true"]')]) {
      const cls = (el.className || '').toString();
      const val = (el.value || el.innerText || '').trim();
      out.push({ tag: el.tagName, cls: cls.slice(0, 90), id: el.id || '', len: val.length, head: val.slice(0, 40) });
    }
    return out;
  });
  console.log('正文编辑区候选（len>0 表示已填）:', JSON.stringify(bodyCands.filter(c => c.len > 0), null, 2));
  console.log('所有编辑区总数:', bodyCands.length);

  // 3) 「发布文章」按钮
  const pubBtns = await page.evaluate(() => {
    const out = [];
    for (const b of [...document.querySelectorAll('button')]) {
      const t = (b.innerText || '').trim();
      if (t && /发布/.test(t)) out.push({ text: t, cls: (b.className || '').toString().slice(0, 90), visible: b.offsetParent !== null });
    }
    return out;
  });
  console.log('发布按钮:', JSON.stringify(pubBtns, null, 2));

  await page.screenshot({ path: 'probe-csdn-publish-before.png', fullPage: true });
  console.log('screenshot: probe-csdn-publish-before.png');

  // 4) 点「发布文章」→ 看发布设置页
  const btn = page.locator('button:has-text("发布文章"), button.btn-publish:has-text("发布")').filter({ hasText: /发布/ }).first();
  let clicked = false;
  if (await btn.count()) {
    try {
      await btn.click({ force: true });
      clicked = true;
      console.log('已点击发布按钮');
      await page.waitForTimeout(4000);
    } catch (e) {
      console.log('点击发布失败:', e.message);
    }
  } else {
    console.log('未找到发布按钮');
  }

  if (clicked) {
    console.log('点击后 URL:', page.url());
    // dump 发布设置页：所有标有 category/tag/cover/original/summary/声明 的元素
    const settings = await page.evaluate(() => {
      const out = [];
      const kws = /分类|标签|封面|原创|声明|摘要|推荐|发布|取消|保存|下一步|完成/;
      for (const el of [...document.querySelectorAll('div, label, span, input, textarea, button, .tag-selector, [class*="category"], [class*="tag"], [class*="cover"], [class*="original"]')]) {
        const t = (el.innerText || el.placeholder || '').trim();
        if (t && t.length < 24 && kws.test(t)) {
          const cls = (el.className || '').toString();
          out.push({ tag: el.tagName, cls: cls.slice(0, 80), text: t });
        }
      }
      // 去重
      return out.filter((v, i, a) => a.findIndex((x) => x.text === v.text && x.cls === v.cls) === i).slice(0, 60);
    });
    console.log('发布设置页元素:', JSON.stringify(settings, null, 2));

    // 抓所有 file input（封面上传）
    const fileInputs = await page.evaluate(() =>
      [...document.querySelectorAll('input[type="file"]')].map((f) => ({
        accept: f.accept || '', cls: (f.className || '').slice(0, 60),
        parent: (f.parentElement ? f.parentElement.outerHTML : '').slice(0, 160),
      }))
    );
    console.log('封面 file inputs:', JSON.stringify(fileInputs, null, 2));

    await page.screenshot({ path: 'probe-csdn-publish-after.png', fullPage: true });
    console.log('screenshot: probe-csdn-publish-after.png');
  }

  await page.waitForTimeout(1500);
  await ctx.close();
  console.log('探测完成，窗口已关闭');
})();
