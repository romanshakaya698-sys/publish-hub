/**
 * CSDN 编辑器正文填充探测（headless，profile 已登录）
 * 目标：
 *  1) 确认标题 input 用 fill 是否成功
 *  2) 找到正确的正文编辑区（Markdown 源码 contenteditable / 富文本模式）
 *  3) 定位「使用富文本编辑器」按钮，测试切富文本后正文区结构
 * 避免误填 AI 聊天 iframe。
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
  // 优先用 base URL（默认新文章），可通过 env CSDN_URL 覆盖
  const url = process.env.CSDN_URL || 'https://editor.csdn.net/md/';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(8000);
  console.log('URL:', page.url());

  // 1) 所有 iframe 的 src（确认 AI 助手是 iframe）
  const iframes = await page.evaluate(() =>
    [...document.querySelectorAll('iframe')].map((f) => ({ id: f.id || '', name: f.name || '', src: (f.src || '').slice(0, 100) }))
  );
  console.log('iframes:', JSON.stringify(iframes, null, 2));

  // 2) 所有带 contenteditable 的元素（含源码区、富文本区）
  const ceds = await page.evaluate(() =>
    [...document.querySelectorAll('[contenteditable]')].map((el) => ({
      tag: el.tagName, cls: (el.className || '').toString().slice(0, 100),
      id: el.id || '', text: (el.innerText || '').trim().slice(0, 80),
    }))
  );
  console.log('contenteditable 元素:');
  for (const c of ceds) console.log(' ', JSON.stringify(c));

  // 3) 所有 textarea
  const tas = await page.evaluate(() =>
    [...document.querySelectorAll('textarea')].map((el) => ({
      cls: (el.className || '').toString().slice(0, 100), id: el.id || '',
      ph: el.placeholder || '', text: (el.value || '').slice(0, 80),
    }))
  );
  console.log('textarea 元素:', JSON.stringify(tas, null, 2));

  // 4) 富文本切换按钮
  const richBtn = await page.evaluate(() => {
    for (const el of [...document.querySelectorAll('button, a, span, div')]) {
      const t = (el.innerText || el.title || '').trim();
      if (/使用富文本编辑器/.test(t)) return { text: t, tag: el.tagName, cls: (el.className || '').slice(0, 100) };
    }
    return null;
  });
  console.log('富文本切换按钮:', JSON.stringify(richBtn, null, 2));

  // 5) 标题 input fill 测试
  const titleInput = page.locator('input.article-bar__title').first();
  console.log('标题 input count:', await titleInput.count());
  if (await titleInput.count()) {
    const before = await titleInput.inputValue().catch(() => '');
    console.log('标题当前值:', JSON.stringify(before));
    await titleInput.fill('CSDN 标题填充测试：6款GEO监控工具横向对比');
    await page.waitForTimeout(500);
    const after = await titleInput.inputValue().catch(() => '');
    console.log('标题 fill 后:', JSON.stringify(after));
  }

  // 6) 测试主正文区（Markdown 源码区）能否直接填——找 .editor__inner 附近的输入区
  // CSDN 的 Markdown 源码区可能是 CodeMirror 实例。尝试用键盘输入到焦点区。
  await page.screenshot({ path: 'probe-csdn-main.png', fullPage: true });
  console.log('screenshot: probe-csdn-main.png');
  await ctx.close();
})();
