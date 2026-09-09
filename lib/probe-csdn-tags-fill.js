/**
 * CSDN 标签填充完整验证（headed，副本 profile）
 * 流程：填标题 → 点「发布文章」进设置页 → csdnFillTags 填标签（不按 Escape 关弹窗）→
 *       dump 当前弹窗里精确匹配的标签 chip → 截图
 * 验证：标签真的生成 chip，且弹窗未连发布设置页一起关闭。
 */
const path = require('path');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, '..', 'browsers');
}
const { chromium } = require('playwright');

const profileDir = process.env.PROBE_PROFILE || path.join(__dirname, '..', 'profiles', 'bot', 'csdn');
const TAGS = ['人工智能', '大数据', 'GEO搜索'];

async function csdnFillTags(page, tags, log) {
  const addBtn = page.locator('button.tag__btn-tag').first();
  if (!(await addBtn.count())) { log('⚠ 未找到「+ 添加文章标签」按钮'); return false; }
  try { await addBtn.click({ force: true }); await page.waitForTimeout(1200); }
  catch (e) { log(`⚠ 打开标签面板失败：${e.message}`); return false; }

  const inputSel = 'input[placeholder*="标签"], .el-dialog input, .el-dialog__wrapper input, input[placeholder*="搜索"], input[placeholder*="自定义"]';
  let added = 0;
  for (const t of tags) {
    try {
      const input = page.locator(inputSel).filter({ visible: true }).first();
      if (!(await input.count())) { log(`⚠ 未找到标签输入框，t=${t}`); break; }
      await input.click({ force: true });
      await page.waitForTimeout(250);
      await page.evaluate((val) => {
        const el = document.activeElement && document.activeElement.tagName === 'INPUT' ? document.activeElement : null;
        if (!el) return;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, t);
      await page.waitForTimeout(300);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(400);
      added++;
      log(`+ 标签「${t}」`);
    } catch (e) { log(`⚠ 标签「${t}」失败：${e.message}`); }
  }
  // 不按 Escape（会连发布设置页一起关）。若标签弹窗有独立 X 则点它，否则保持打开。
  const dismissBtn = page
    .locator('.el-dialog__headerbtn, .el-dialog .el-dialog__header .el-dialog__headerbtn, .el-dialog__wrapper .el-dialog__headerbtn')
    .first();
  if (await dismissBtn.count()) { await dismissBtn.click({ force: true }).catch(() => {}); await page.waitForTimeout(400); }
  return added > 0;
}

async function dumpTagDialog(page) {
  const chips = await page.evaluate(() => {
    const out = [];
    for (const el of [...document.querySelectorAll('body *')]) {
      const t = (el.innerText || '').trim();
      const vis = el.offsetParent !== null;
      if (vis && t && t.length <= 8 && /^(人工智能|大数据|GEO搜索)$/.test(t)) {
        const cls = (el.className || '').toString();
        out.push({ text: t, tag: el.tagName, cls: cls.slice(0, 70) });
      }
    }
    return out.slice(0, 30);
  });
  console.log('页面上的标签 chip（精确匹配）:');
  if (!chips.length) console.log('  (无 chip)');
  for (const c of chips) console.log(' ', JSON.stringify(c));
}

(async () => {
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: false, viewport: { width: 1600, height: 950 },
    args: ['--disable-blink-features=AutomationControlled', '--window-position=60,60'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto('https://editor.csdn.net/md/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);

  await page.evaluate((t) => {
    const el = document.querySelector('input.article-bar__title--input, input.article-bar__title, input[placeholder*="标题"]');
    if (el) { el.focus(); const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(el, t); el.dispatchEvent(new Event('input', { bubbles: true })); }
  }, '从功能到性价比，6款主流GEO监控工具横向对比与选型建议');
  await page.waitForTimeout(600);

  const pubBtn = page.locator('button.btn-publish:has-text("发布文章"), button:has-text("发布文章")').filter({ hasText: /发布文章/ }).first();
  if (await pubBtn.count()) { await pubBtn.click({ force: true }); await page.waitForTimeout(2500); }
  console.log('已进入发布设置页, URL:', page.url());

  const ok = await csdnFillTags(page, TAGS, (m) => console.log(m));
  console.log('标签填充结果:', ok);

  await dumpTagDialog(page);
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'probe-csdn-tags-filled.png', fullPage: true });
  console.log('screenshot: probe-csdn-tags-filled.png');
  await ctx.close();
})();
