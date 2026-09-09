/**
 * 探测知乎/CSDN 是否对 headless 反爬：
 *  - 先用 headed 模式让用户扫码登录（脚本会保持打开等扫码）
 *  - 登录成功后保留 headed 窗口，再启动第二个 headless 实例，访问同一个 publishUrl 看是否被踢回登录页
 *  - 若 headless 被踢 = 反爬，跟网易号一样不能用无头 auto
 *  - 若 headless 能进 = 无反爬，可走 auto
 *
 * 用法：node lib/probe-zhihu-csdn.js [platformId]
 *   platformId: zhihu 或 csdn
 */
const path = require('path');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, '..', 'browsers');
}
const { chromium } = require('playwright');

const platformId = process.argv[2];
if (!['zhihu', 'csdn'].includes(platformId)) {
  console.error('用法: node lib/probe-zhihu-csdn.js [zhihu|csdn]');
  process.exit(1);
}

const profileDir = path.join(__dirname, '..', 'profiles', 'bot', platformId);
const loginUrl = platformId === 'zhihu' ? 'https://www.zhihu.com/signin' : 'https://passport.csdn.net/login';
const publishUrl = platformId === 'zhihu' ? 'https://zhuanlan.zhihu.com/publish' : 'https://editor.csdn.net/md/';

(async () => {
  console.log('=== Phase 1: headed 登录窗口（保持打开等用户扫码）===');
  const headedCtx = await chromium.launchPersistentContext(profileDir, {
    headless: false, viewport: { width: 1440, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = await headedCtx.newPage();
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('登录窗口已打开:', page.url());
  console.log('请扫码/邮箱登录，登录成功会跳到非登录页');

  const loginFragments = ['signin', 'login', 'passport'];
  const deadline = Date.now() + 8 * 60 * 1000; // 8 分钟
  let loggedIn = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    if (page.isClosed()) { console.log('用户关闭了登录窗口'); await headedCtx.close(); process.exit(2); }
    const url = page.url();
    if (!loginFragments.some((f) => url.includes(f))) {
      console.log('LOGGED_IN url=' + url);
      loggedIn = true;
      break;
    }
  }
  if (!loggedIn) {
    console.log('TIMEOUT（8 分钟未登录）');
    await headedCtx.close();
    process.exit(1);
  }
  // 等几秒让 cookie 稳定落盘
  await page.waitForTimeout(3000);
  await page.close();
  await headedCtx.close();
  console.log('headed 窗口已关闭');

  console.log('\n=== Phase 2: headless 探测同一 profile，看是否被踢 ===');
  const hdCtx = await chromium.launchPersistentContext(profileDir, {
    headless: true, viewport: { width: 1440, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const hdPage = await hdCtx.newPage();
  await hdPage.goto(publishUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await hdPage.waitForTimeout(5000);
  const finalUrl = hdPage.url();
  console.log('headless publishUrl:', finalUrl);
  console.log('navigator.webdriver:', await hdPage.evaluate(() => navigator.webdriver));
  const onLoginPage = loginFragments.some((f) => finalUrl.includes(f));
  console.log('被踢回登录页?', onLoginPage);

  // 抓 title 与 body 第一段
  const title = await hdPage.title();
  const body0 = await hdPage.evaluate(() => (document.body.innerText || '').trim().slice(0, 300));
  console.log('page title:', title);
  console.log('body[0:300]:', body0);

  await hdPage.screenshot({ path: `probe-${platformId}-headless.png`, fullPage: true });
  console.log(`screenshot: probe-${platformId}-headless.png`);

  await hdCtx.close();
  console.log(onLoginPage ? '结论：反 headless / 反爬' : '结论：headless 可用');
  process.exit(onLoginPage ? 10 : 0);
})();
