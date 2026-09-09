/**
 * CSDN 发布设置页-文章标签 填充探测（headed，复用已登录 profile）
 * 目标：点「+ 添加文章标签」→ 打开标签弹窗 → 找输入框 → 输入标签 + Enter → 关闭
 * 为 csdnFillTags 提供真实选择器。
 */
const path = require('path');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, '..', 'browsers');
}
const { chromium } = require('playwright');

const profileDir = process.env.PROBE_PROFILE || path.join(__dirname, '..', 'profiles', 'bot', 'csdn');

(async () => {
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: false, viewport: { width: 1600, height: 950 },
    args: ['--disable-blink-features=AutomationControlled', '--window-position=60,60'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto('https://editor.csdn.net/md/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);

  // 先填标题（native setter）
  const title = '从功能到性价比，6款主流GEO监控工具横向对比与选型建议';
  await page.evaluate((t) => {
    const el = document.querySelector('input.article-bar__title--input, input.article-bar__title, input[placeholder*="标题"]');
    if (el) { el.focus(); const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(el, t); el.dispatchEvent(new Event('input', { bubbles: true })); }
  }, title);
  await page.waitForTimeout(600);

  // 点「发布文章」进设置页
  const pubBtn = page.locator('button.btn-publish:has-text("发布文章"), button:has-text("发布文章")').filter({ hasText: /发布文章/ }).first();
  if (await pubBtn.count()) {
    await pubBtn.click({ force: true }).catch((e) => console.log('点发布失败', e.message));
    await page.waitForTimeout(3000);
  }
  console.log('点击发布后 URL:', page.url());

  // 找「添加文章标签」入口
  const addTagTrigger = await page.evaluate(() => {
    for (const el of [...document.querySelectorAll('button, span, div, a')]) {
      const t = (el.innerText || '').trim();
      if (/添加文章标签/.test(t)) return { text: t, tag: el.tagName, cls: (el.className || '').toString().slice(0, 90) };
    }
    return null;
  });
  console.log('添加标签入口:', JSON.stringify(addTagTrigger, null, 2));

  // 点击打开标签弹窗
  try {
    const trigger = page.locator('button:has-text("添加文章标签"), span:has-text("添加文章标签"), div:has-text("添加文章标签")').first();
    if (await trigger.count()) { await trigger.click({ force: true }); await page.waitForTimeout(1500); }
  } catch (e) { console.log('点标签入口失败', e.message); }

  // dump 标签弹窗结构
  const tagDialog = await page.evaluate(() => {
    const out = [];
    // 弹窗输入框
    for (const el of [...document.querySelectorAll('input, textarea')]) {
      const ph = el.placeholder || '';
      const cls = (el.className || '').toString().slice(0, 90);
      const vis = el.offsetParent !== null;
      if (vis && (/标签|搜索|输入/.test(ph) || el.getAttribute('placeholder'))) out.push({ kind: 'input', ph, cls, vis });
    }
    // 弹窗里可点的推荐标签
    for (const el of [...document.querySelectorAll('span, button, div, li')]) {
      const t = (el.innerText || '').trim();
      const cls = (el.className || '').toString();
      const vis = el.offsetParent !== null;
      if (vis && t && t.length < 12 && /人工智能|大数据|产品运营|新媒体|推荐|Python|Java|标签/.test(t)) {
        out.push({ kind: 'tag', text: t, tag: el.tagName, cls: cls.slice(0, 70), vis });
      }
    }
    return out.slice(0, 45);
  });
  console.log('标签弹窗元素:');
  for (const e of tagDialog) console.log(' ', JSON.stringify(e));

  await page.screenshot({ path: 'probe-csdn-tags.png', fullPage: true });
  console.log('screenshot: probe-csdn-tags.png');
  await ctx.close();
})();
