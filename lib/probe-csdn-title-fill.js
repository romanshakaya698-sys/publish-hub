/**
 * CSDN 标题填充 + 发布设置页 验证（headed，复用已登录 profile）
 * 目标：找到能让标题计数从 0 变正的可靠方式，并确认点发布后进入发布设置页。
 */
const path = require('path');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, '..', 'browsers');
}
const { chromium } = require('playwright');

const profileDir = path.join(__dirname, '..', 'profiles', 'bot', 'csdn');

async function tryFillTitle(method) {
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: false, viewport: { width: 1600, height: 950 },
    args: ['--disable-blink-features=AutomationControlled', '--window-position=60,60'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto('https://editor.csdn.net/md/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);

  const title = '从功能到性价比，6款主流GEO监控工具横向对比与选型建议';
  console.log(`\n===== 方法: ${method} =====`);
  try {
    if (method === 'click+input') {
      // 点击标题占位区 → 让 input 可见聚焦
      await page.locator('.article-bar__title, .article-bar, input[placeholder*="标题"]').first().click({ force: true }).catch(() => {});
      await page.waitForTimeout(600);
      // 用 keyboard 逐字输入，触发 React onChange
      const input = page.locator('input.article-bar__title--input, input[placeholder*="标题"]').first();
      const count = await input.count();
      console.log('input count:', count);
      if (count) {
        await input.click({ force: true });
        // 清空已有
        await input.press('Meta+A').catch(() => {});
        await input.press('Backspace').catch(() => {});
        await input.fill(''); // 清空
        // 逐字粘贴
        await page.evaluate((t) => {
          const el = document.querySelector('input.article-bar__title--input, input[placeholder*="标题"]');
          if (!el) return;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, t);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }, title);
        await page.waitForTimeout(800);
        const val = await input.inputValue().catch(() => '');
        console.log('设值后 input.value:', JSON.stringify(val));
      }
    } else if (method === 'keyboard-type') {
      await page.locator('.article-bar__title, input[placeholder*="标题"]').first().click({ force: true }).catch(() => {});
      await page.waitForTimeout(500);
      const input = page.locator('input.article-bar__title--input, input[placeholder*="标题"]').first();
      await input.click({ force: true });
      await page.keyboard.type(title, { delay: 10 });
      await page.waitForTimeout(800);
      const val = await input.inputValue().catch(() => '');
      console.log('输入后 input.value:', JSON.stringify(val));
    } else if (method === 'evaluate-native') {
      await page.evaluate((t) => {
        const el = document.querySelector('input.article-bar__title--input, input[placeholder*="标题"]');
        if (!el) return 'no el';
        el.focus();
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, t);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, title);
      await page.waitForTimeout(800);
      const val = await page.evaluate(() => document.querySelector('input.article-bar__title--input, input[placeholder*="标题"]')?.value);
      console.log('native 设值后 input.value:', JSON.stringify(val));
    }
  } catch (e) {
    console.log('方法失败:', e.message);
  }

  // 读标题计数 (0/100 或 28/100)
  const counter = await page.evaluate(() => {
    const el = [...document.querySelectorAll('span, div')].find((e) => /\/100/.test(e.innerText || ''));
    return el ? el.innerText.trim() : null;
  });
  console.log('标题计数:', counter);

  await page.screenshot({ path: `probe-csdn-title-${method}.png`, fullPage: true });
  await ctx.close();
  return counter;
}

(async () => {
  const c1 = await tryFillTitle('click+input');
  const c2 = await tryFillTitle('keyboard-type');
  const c3 = await tryFillTitle('evaluate-native');
  console.log('\n===== 结论 =====');
  console.log('click+input 计数:', c1);
  console.log('keyboard-type 计数:', c2);
  console.log('evaluate-native 计数:', c3);
})();
