/**
 * 发布引擎：通用发布脚本（按平台配置的选择器执行）
 * 两种模式：
 *  - confirm（预填+人工确认，默认）：自动填好标题/正文/封面，停在发文页等人工点发布
 *  - auto（全自动）：自动点击发布按钮
 */
const path = require('path');
const fs = require('fs');
const statusBot = require('./bot');
const { DEFAULT_PLATFORMS } = require('./platforms');
const store = require('./store');

// ---------- 平台配置（默认 + 用户覆盖） ----------
function getPlatform(id) {
  const base = DEFAULT_PLATFORMS.find((p) => p.id === id);
  if (!base) return null;
  const override = store.getSettings().platforms?.[id] || {};
  return { ...base, ...override, selectors: { ...base.selectors, ...(override.selectors || {}) } };
}
function listPlatforms() {
  return DEFAULT_PLATFORMS.map((p) => getPlatform(p.id));
}

// ---------- 工具 ----------
function ts() {
  return new Date().toLocaleTimeString('zh-CN');
}

async function firstMatch(page, selectors, { timeout = 3000 } = {}) {
  for (const sel of selectors || []) {
    try {
      const locs = page.locator(sel);
      const first = locs.first();
      try {
        await first.waitFor({ state: 'visible', timeout });
        return first;
      } catch {
        // 第一个匹配可能藏在隐藏容器里（如大鱼号封面全屏区块），
        // 扫描其余匹配项，找第一个「可见」的
        const n = Math.min(await locs.count().catch(() => 0), 10);
        for (let i = 1; i < n; i++) {
          const loc = locs.nth(i);
          if (await loc.isVisible().catch(() => false)) return loc;
        }
      }
    } catch { /* try next */ }
  }
  return null;
}

/**
 * 稳健定位「发布」按钮（平台感知）：
 * 优先用平台定义的 publishBtn 选择器（如大鱼号按钮文字是「发表」）；
 * 企鹅号发布按钮在底部固定工具栏（footer.tool-*），querySelector 可能匹配不到
 * （未滚动/渲染时序），这里用节点遍历兜底：按平台按钮文案找 primary button。
 * 返回 Playwright Locator，找不到返回 null。
 */
async function findPublishBtn(page, platform) {
  const btnTexts = (platform && platform.selectors.publishBtnText) || ['发布'];
  // 1) 平台配置的选择器优先
  const configured = (platform && platform.selectors.publishBtn) || [];
  if (configured.length) {
    const loc = await firstMatch(page, configured, { timeout: 2500 });
    if (loc) return loc;
  }
  // 2) 企鹅号等旧选择器兜底
  const tried = await firstMatch(page, [
    'button.omui-button--primary:has-text("发布")',
    '.publish-btn',
    'button:has-text("发布")',
  ], { timeout: 2000 });
  if (tried) return tried;
  // 3) 节点遍历兜底：找 innerText 恰为按钮文案的 button/a
  const found = await page.evaluate((texts) => {
    const els = [...document.querySelectorAll('button, a, [role="button"]')];
    const exact = els.filter((el) => texts.includes((el.innerText || '').trim()) && el.children.length <= 1);
    if (exact.length) {
      const el = exact[0];
      el.scrollIntoView({ block: 'center' });
      el.style.outline = '3px solid #1a73e8';
      el.style.outlineOffset = '2px';
      return true;
    }
    return false;
  }, btnTexts);
  if (found) {
    const rx = new RegExp(`^(${btnTexts.join('|')})$`);
    return page.locator('button, a, [role="button"]').filter({ hasText: rx }).first();
  }
  return null;
}

/** 填标题 */
async function fillTitle(page, platform, title, log) {
  const loc = await firstMatch(page, platform.selectors.title);
  if (!loc) {
    log('⚠ 未找到标题输入框，请手动填写');
    return false;
  }
  await loc.click();
  await loc.fill('');
  await loc.fill(title);
  log(`✓ 已填写标题：${title}`);
  return true;
}

/**
 * 填正文：支持 contenteditable（ProseMirror 等）与 iframe 富文本（UEditor 等）
 * 通过 execCommand('insertHTML') 插入，兼容绝大多数编辑器
 */
/** 给正文里的所有 <img> 注入居中样式（避免企鹅号/网易号渲染成靠左） */
function ensureImagesCentered(html) {
  return html.replace(/<img\b([^>]*)>/gi, (m, attrs) => {
    const center = 'display:block;margin:0 auto;max-width:100%';
    if (/style=/i.test(attrs)) {
      // 已带 style，追加居中样式（不破坏已有内容）
      return m.replace(/style="([^"]*)"/i, (sm, s) => sm.replace(s, `${s};${center}`));
    }
    return `<img ${attrs} style="${center}">`;
  });
}

/**
 * 通用 iframe 富文本编辑器填充（大鱼号 UEditor 等）。
 * 只在平台显式声明 contentMode='iframe' 时调用，
 * 避免误填页面上的辅助 iframe（如 CSDN 内置 AI 助手聊天框）。
 */
async function fillFrameEditor(page, html, log) {
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    try {
      const body = frame.locator('body[contenteditable="true"], body');
      const editable = frame.locator('[contenteditable="true"]').first();
      const target = (await editable.count()) > 0 ? editable : body;
      if ((await target.count()) > 0) {
        await target.click({ timeout: 3000 });
        await frame.evaluate(() => {
          document.execCommand('selectAll', false, null);
          document.execCommand('delete', false, null);
        });
        await frame.evaluate((h) => {
          document.execCommand('insertHTML', false, h);
        }, html);
        log('✓ 已填入正文（iframe 编辑器）');
        return true;
      }
    } catch {
      /* next frame */
    }
  }
  return false;
}

/** 主文档 contenteditable 填充（ProseMirror / Draft.js 等） */
async function fillDomEditor(page, platform, html, log) {
  const loc = await firstMatch(page, platform.selectors.content, { timeout: 4000 });
  if (!loc) return false;
  await loc.click();
  await page.evaluate(() => {
    const sel = window.getSelection();
    sel.selectAllChildren(document.activeElement);
  });
  await page.evaluate((h) => {
    document.execCommand('insertHTML', false, h);
  }, html);
  log('✓ 已填入正文');
  return true;
}

/**
 * CSDN 专属正文填充。
 * CSDN 默认是 Markdown 编辑器（源码区 pre.editor__inner 不适合直接 insertHTML 富文本），
 * 且页面右侧内置 AI 助手聊天 iframe（带 contenteditable），会被通用 iframe 分支误填。
 * 策略：点「使用富文本编辑器」把 CSDN 切换成富文本模式，再往主文档 contenteditable 填 HTML。
 * 为避开 AI 输入框，切富文本后优先用精确选择器，找不到再取「面积最大的可见 contenteditable」。
 */
async function csdnFillContent(page, html, log) {
  // 1) 切富文本：按钮文案可能是「使用富文本编辑器」或「切换到富文本编辑器」
  const switchBtn = page
    .locator('button:has-text("富文本编辑器"), button:has-text("切换到富文本"), .editor-mode-btn')
    .filter({ hasText: /富文本/ })
    .first();
  if (await switchBtn.count()) {
    const txt = (await switchBtn.innerText().catch(() => '')).trim();
    const alreadyRich = /Markdown|源码|切换回|切回/.test(txt); // 若按钮已是「切换到Markdown」说明已是富文本
    if (!alreadyRich) {
      await switchBtn.scrollIntoViewIfNeeded().catch(() => {});
      await switchBtn.click({ force: true }).catch(() => {});
      log('已切换「使用富文本编辑器」');
      await page.waitForTimeout(2000);
    }
  }

  // 2) 依次尝试精确正文选择器
  const precise = [
    '.editor__inner[contenteditable="true"]',
    'pre.editor__inner[contenteditable="true"]',
    '.article-content .ProseMirror',
    'div[contenteditable="true"].editor__inner',
  ];
  for (const sel of precise) {
    const loc = page.locator(sel).first();
    try {
      if ((await loc.count()) && (await loc.isVisible().catch(() => false))) {
        await loc.click();
        await page.evaluate(() => {
          const sel = window.getSelection();
          sel.selectAllChildren(document.activeElement);
        });
        await page.evaluate((h) => document.execCommand('insertHTML', false, h), html);
        log('✓ 已填入 CSDN 正文（富文本编辑器）');
        return true;
      }
    } catch { /* next */ }
  }

  // 3) 兜底：主文档里取「面积最大的可见 contenteditable」，天然避开右侧 AI 输入框
  const box = await page.evaluate(() => {
    const cands = [...document.querySelectorAll('[contenteditable="true"]')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 200 && r.height > 120;
    });
    if (!cands.length) return null;
    cands.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
    const el = cands[0];
    el.scrollIntoView({ block: 'center' });
    return true;
  });
  if (box) {
    const big = page.locator('[contenteditable="true"]').first();
    // 重新定位到面积最大的那个（点击最中央）
    await page.evaluate(() => {
      const cands = [...document.querySelectorAll('[contenteditable="true"]')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 200 && r.height > 120;
      });
      cands.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
      const el = cands[0];
      el.focus();
      const sel = window.getSelection();
      sel.selectAllChildren(el);
    });
    await page.evaluate((h) => document.execCommand('insertHTML', false, h), html);
    log('✓ 已填入 CSDN 正文（最大编辑区）');
    return true;
  }

  log('⚠ 未定位到 CSDN 正文编辑区，请手动粘贴');
  return false;
}

async function fillContent(page, platform, html, log) {
  html = ensureImagesCentered(html);
  // CSDN 专属：必须先切「富文本编辑器」，因为默认 Markdown 模式源码区
  // 无法直接 insertHTML 富文本；且右侧内置 AI 助手聊天 iframe 会被误填。
  if (platform.id === 'csdn') {
    const ok = await csdnFillContent(page, html, log);
    if (!ok) log('⚠ CSDN 正文未能自动填入，请手动粘贴正文');
    return ok;
  }
  // 显式用 iframe 编辑器（大鱼号 UEditor）→ 只走 iframe 通道
  if (platform.contentMode === 'iframe') {
    if (await fillFrameEditor(page, html, log)) return true;
    log('⚠ 未识别到 iframe 富文本编辑器，请手动粘贴正文');
    return false;
  }
  // 其余平台：主文档 contenteditable（企鹅号 ProseMirror / 知乎 Draft.js）
  if (await fillDomEditor(page, platform, html, log)) return true;
  log('⚠ 未识别到富文本编辑器，请手动粘贴正文');
  return false;
}

/** 上传封面（适配带 tab 的封面弹窗 top: 文内图片 / 本地上传 / 我的素材） */
async function uploadCover(page, platform, coverPath, log) {
  if (!coverPath) {
    log('未设置封面，跳过（可人工补充）');
    return false;
  }
  const trigger = await firstMatch(page, platform.selectors.coverTrigger, { timeout: 4000 });
  if (!trigger) {
    log('⚠ 未找到「添加封面」入口，请手动上传');
    return false;
  }

  // 1) 先尝试原生 filechooser 通道（少数平台直接调系统选择器）
  try {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 2200 }),
      trigger.click(),
    ]);
    await chooser.setFiles(coverPath);
    log('✓ 封面已通过系统选择器上传');
    return true;
  } catch { /* 走弹窗分支 */ }

  // 2) 弹窗分支：等「添加封面」弹窗（omui-dialog）出现，切「本地上传」→ 传文件 → 点确认
  try {
    const dlg = page.locator('.omui-dialog-wrapper.open, .omui-dialog, [role="dialog"]').last();
    await dlg.waitFor({ state: 'visible', timeout: 8000 });

    // 切到「本地上传」tab（文字精确匹配，取可点击祖先）
    const localTab = dlg.locator(':text-is("本地上传")').first();
    if (await localTab.count()) {
      await localTab.click({ force: true }).catch(() => {});
      await page.waitForTimeout(700);
    }

    // 等 <input type="file"> 出现（切 tab 后才渲染）
    let fileInput = page.locator('input[type="file"]').first();
    await fileInput.waitFor({ state: 'attached', timeout: 6000 }).catch(() => {});
    if (!(await fileInput.count())) {
      log('⚠ 封面弹窗里没找到文件控件，请手动上传');
      return false;
    }

    await fileInput.setInputFiles(coverPath);
    log('✓ 封面文件已注入本地上传控件');
    // 等上传完成（缩略图/预览出来），最多 10s 轮询
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(1000);
      const ok = await page.evaluate(() => {
        const dlg = document.querySelector('.omui-dialog-wrapper.open, .omui-dialog');
        if (!dlg) return false;
        const txt = (dlg.innerText || '').toLowerCase();
        const uploaded = /上传成功|已上传|1\/1|删除|重新上传/.test(txt);
        const busy = /正在上传|上传中|加载中|%.*%/.test(txt);
        return uploaded || !busy;
      }).catch(() => true);
      if (ok) break;
    }

    // 点「确认」按钮：限定弹窗 footer 内、文字严格等于「确认」的 primary 按钮
    const confirmBtn = dlg.locator(
      '.omui-dialog-footer button:has-text("确认"), .omui-dialog-footer button:has-text("确定"), button:has-text("确认"), button:has-text("确定")'
    ).first();
    if (await confirmBtn.count()) {
      await confirmBtn.scrollIntoViewIfNeeded().catch(() => {});
      await confirmBtn.click().catch(() => {});
      await page.waitForTimeout(1200);
      log('✓ 封面已上传并应用');
    } else {
      log('⚠ 弹窗里没找到「确认」按钮，请手动点确认');
      return false;
    }

    // 弹窗仍开着就再补点一下关闭
    const stillOpen = dlg.locator('.omui-dialog-wrapper.open').count();
    if (await stillOpen) {
      const x = dlg.locator('.omui-dialog-close, [class*="dialog-close"], [class*="close"]').first();
      if (await x.count()) await x.click({ force: true }).catch(() => {});
    }
    return true;
  } catch (e) {
    log(`⚠ 封面上传失败：${e.message || e}（请手动上传）`);
    return false;
  }
}

// 通过可见文字验证分类是否真的选上了（omui 组件的 input.value 不一定写值）
async function verifySelectPicked(page, value) {
  return await page.evaluate((v) => {
    // 分类框内显示选中项的位置：omui-suggestion__single-value 或者相邻的 div
    const sv = document.querySelector('.omui-suggestion__single-value, .omui-suggestion__selected, .omui-suggestion__current');
    if (sv && (sv.innerText || '').trim() === v) return { ok: true, txt: (sv.innerText || '').trim() };
    // 备选：分类 label 旁边的 .omui-suggestion__control 内若出现 v
    const ctrls = [...document.querySelectorAll('.omui-suggestion__control')];
    for (const c of ctrls) {
      const txt = (c.innerText || '').trim();
      if (txt === v || txt.includes(v)) return { ok: true, txt };
    }
    return { ok: false, txt: '' };
  }, value);
}

// 在虚拟列表里通过 keyboard 输入触发联想过滤，再选目标
async function pickVirtualOption(page, optionSel, value, dropdownWrap, log) {
  // 1) 先在 DOM 里直接找（不滚动）
  let found = await page.evaluate(
    ({ optionSel, value }) => {
      const opts = [...document.querySelectorAll(optionSel)];
      const idx = opts.findIndex((o) => (o.innerText || '').trim() === value);
      return idx >= 0 ? { ok: true, index: idx } : { ok: false };
    },
    { optionSel, value },
  );
  if (found.ok) return found;

  // 2) 试一次滚动（scroller.scrollTop）
  found = await page.evaluate(
    ({ optionSel, value, dropdownWrap }) => {
      const wrap = document.querySelector(dropdownWrap || '.omui-suggestion__dropdown-wrap');
      if (!wrap) return { ok: false };
      const scroller = wrap.querySelector('[style*="overflow: auto"], [style*="overflow:auto"]') || wrap.firstElementChild;
      if (!scroller) return { ok: false };
      for (let i = 0; i < 80; i++) {
        scroller.scrollTop += 200;
        const opts = [...wrap.querySelectorAll(optionSel)];
        const idx = opts.findIndex((o) => (o.innerText || '').trim() === value);
        if (idx >= 0) return { ok: true, index: idx };
      }
      return { ok: false };
    },
    { optionSel, value, dropdownWrap: dropdownWrap || '.omui-suggestion__dropdown-wrap' },
  );
  if (found.ok) return found;

  // 3) 通过 keyboard 输入让组件过滤（很多 omui suggestion 支持输入过滤）
  const input = await page.locator(`${dropdownWrap || '.omui-suggestion__dropdown-wrap'}`).count()
    ? null
    : null;
  // 真正能触发的输入框是 input.omui-suggestion__value。我们用 keyboard.type 直接输入
  return { ok: false, needType: true };
}

/** 填分类等下拉选择：点开、滚动虚拟列表 / 输入过滤、再点包含文字的选项 */
async function fillSelect(page, field, value, log) {
  if (!value) return false;
  let loc = null;
  if (field.index !== undefined) {
    loc = page.locator((field.selectors || []).join(', ')).nth(field.index);
    try { await loc.waitFor({ state: 'visible', timeout: 2500 }); } catch {}
  } else {
    loc = await firstMatch(page, field.selectors, { timeout: 2500 });
  }
  if (!loc || !(await loc.count())) {
    log(`⚠ 未找到「${field.label}」输入框`);
    return false;
  }
  try {
    // 路径 0：优先点字段旁的「常用分类」快捷芯片（span.omui-tag）
    // 分类下拉是绝对定位虚拟列表（只渲染前 9 项），点芯片是最稳的方式
    const selStr = (field.selectors || ['input.omui-suggestion__value']).join(', ');
    const chipClicked = await page.evaluate(
      ({ sel, idx, value }) => {
        const inputs = [...document.querySelectorAll(sel)];
        const input = inputs[idx];
        if (!input) return false;
        let el = input;
        for (let k = 0; k < 8 && el; k++, el = el.parentElement) {
          const tags = [...(el.querySelectorAll('span.omui-tag') || [])].filter(
            (t) => (t.innerText || '').trim() === value,
          );
          if (tags.length) {
            tags[tags.length - 1].click();
            return true;
          }
        }
        return false;
      },
      { sel: selStr, idx: field.index ?? 0, value },
    );
    if (chipClicked) {
      await page.waitForTimeout(600);
      const verify = await verifySelectPicked(page, value);
      if (verify.ok) {
        log(`✓ 已选择「${field.label}」：${value}（常用分类快捷芯片）`);
        return true;
      }
    }

    await loc.scrollIntoViewIfNeeded().catch(() => {});
    await loc.click({ force: true });
    await page.waitForTimeout(600);

    const dropdownWrap = field.dropdownWrap || '.omui-suggestion__dropdown-wrap';
    await page.locator(dropdownWrap).first().waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});

    const optionSel = field.optionSelector || '.omui-suggestion__option';

    // 路径 A：直接在 DOM / 滚动虚拟列表里找
    let found = await pickVirtualOption(page, optionSel, value, dropdownWrap, log);
    if (found.ok) {
      const opt = page.locator(optionSel).nth(found.index);
      await opt.click({ force: true }).catch(() => {});
      await page.waitForTimeout(500);
      const verify = await verifySelectPicked(page, value);
      if (verify.ok) {
        log(`✓ 已选择「${field.label}」：${value}`);
        return true;
      }
    }

    // 路径 B：清空输入 → 键盘输入 value → 触发联想过滤 → 再选第一项
    log(`→ 「${field.label}」DOM 未直接命中，改用键盘输入触发联想`);
    await loc.click({ force: true });
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
    await page.waitForTimeout(200);
    // 用 page.keyboard.type 一字一字敲
    await page.keyboard.type(value, { delay: 80 });
    await page.waitForTimeout(700);
    // 看看 DOM 里现在第一个匹配是不是 value
    const matchIdx = await page.evaluate(
      ({ optionSel, value }) => {
        const opts = [...document.querySelectorAll(optionSel)];
        const exactIdx = opts.findIndex((o) => (o.innerText || '').trim() === value);
        if (exactIdx >= 0) return { ok: true, index: exactIdx, total: opts.length };
        const partialIdx = opts.findIndex((o) => (o.innerText || '').trim().includes(value));
        if (partialIdx >= 0) return { ok: true, index: partialIdx, partial: true, total: opts.length };
        return { ok: false, total: opts.length };
      },
      { optionSel, value },
    );
    if (matchIdx.ok) {
      const opt = page.locator(optionSel).nth(matchIdx.index);
      await opt.click({ force: true }).catch(() => {});
      await page.waitForTimeout(500);
      const verify = await verifySelectPicked(page, value);
      if (verify.ok) {
        log(`✓ 已选择「${field.label}」：${value}`);
        return true;
      }
    }

    log(`⚠ 「${field.label}」未能选中「${value}」`);
    return false;
  } catch (e) {
    log(`⚠ 「${field.label}」自动选择失败：${e.message}`);
    return false;
  }
}

/** 填标签：整段输入 + Enter 形成 chip；遇到下拉联想则选第一项 */
async function fillTags(page, field, value, log) {
  let loc = null;
  if (field.index !== undefined) {
    loc = page.locator((field.selectors || []).join(', ')).nth(field.index);
    try { await loc.waitFor({ state: 'visible', timeout: 2500 }); } catch {}
  } else {
    loc = await firstMatch(page, field.selectors, { timeout: 2500 });
  }
  if (!loc || !(await loc.count())) {
    log(`⚠ 未找到「${field.label}」输入框`);
    return false;
  }
  try {
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    await loc.click({ force: true });
    await page.waitForTimeout(400);
    // 一个标签 = 一段文本（去掉 # 前缀），整段输入后 Enter 形成 chip
    const tags = value
      .split(/[\s,，、]+/)
      .map((t) => t.replace(/^#+/, '').trim())
      .filter(Boolean);
    for (const t of tags) {
      await loc.fill(t);
      await page.waitForTimeout(300);
      // 若出现下拉联想，点第一项
      const dropdown = page
        .locator('.omui-suggestion__dropdown-wrap')
        .filter({ hasText: t })
        .first();
      if (await dropdown.count() && await dropdown.isVisible().catch(() => false)) {
        const first = dropdown.locator('.omui-suggestion__option').first();
        if (await first.count()) {
          await first.click({ force: true }).catch(() => {});
          await page.waitForTimeout(250);
          continue;
        }
      }
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
    }
    log(`✓ 已填写「${field.label}」：${tags.length} 个`);
    return true;
  } catch (e) {
    log(`⚠ 「${field.label}」自动填写失败：${e.message}（请在发文页手动填写）`);
    return false;
  }
}

/** 填自主声明（单选弹窗）：点「添加」→ 选中含该项文字的 radio → 点「确认」 */
async function fillDeclaration(page, field, value, log) {
  if (!value) return false;
  // 1) 点触发按钮打开弹窗（企鹅号真实按钮：omui-button--dashed + 文字「添加内容自主声明」）
  const trigger = await firstMatch(page, field.triggerSelectors || [], { timeout: 3000 });
  if (!trigger) {
    log(`⚠ 未找到「${field.label}」入口按钮（添加内容自主声明）`);
    return false;
  }
  await trigger.scrollIntoViewIfNeeded().catch(() => {});
  await trigger.click({ force: true });
  await page.waitForTimeout(1500);
  // 等弹窗出现
  const dlg = page
    .locator('.omui-dialog-wrapper.open, .omui-dialog, .omui-modal, .modal, [role="dialog"]')
    .filter({ hasText: /声明|虚构|AI|个人观点|营销|健康医疗|危险|转载|参考/ })
    .first();
  await dlg.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  // 2) 在弹窗中找含选项文字的 radio 并点击
  const radio = dlg
    .locator(field.radioSelector || '.omui-radio-wrapper, .omui-radio, .ant-radio-wrapper, label')
    .filter({ hasText: value })
    .first();
  try {
    if (!(await radio.count())) {
      log(`⚠ 弹窗中未找到「${value}」选项，请手动选择`);
      return false;
    }
    await radio.scrollIntoViewIfNeeded().catch(() => {});
    await radio.click({ force: true });
    await page.waitForTimeout(500);
    log(`✓ 已选择「${field.label}」：${value}`);
  } catch (e) {
    log(`⚠ 选择「${field.label}」失败：${e.message}，请手动处理`);
    return false;
  }
  // 3) 点确认（弹窗 footer primary）。多重 selector 兜底，并强制 click + 验证弹窗关闭
  const okSelectors = [
    'button.omui-button.omui-button--primary:not(.omui-button--default)',
    '.omui-dialog-footer button.omui-button--primary',
    '.omui-dialog button.omui-button--primary',
    'button.omui-button--primary',
    'button[class*="primary"]:not([class*="default"])',
  ];
  let okClicked = false;
  for (const sel of okSelectors) {
    const btn = dlg.locator(sel).filter({ hasText: /^(确认|确定|保存|提交)$/ }).first();
    if (await btn.count()) {
      try {
        await btn.scrollIntoViewIfNeeded().catch(() => {});
        await btn.click({ force: true });
        okClicked = true;
        log(`  → 确认按钮已 click（${sel}）`);
        break;
      } catch (e) {
        // 继续下一个选择器
      }
    }
  }
  if (!okClicked) {
    // 兜底：直接 evaluate 找按钮并强制原生 click
    const forced = await page.evaluate(() => {
      const dlg = document.querySelector('.omui-dialog-wrapper.open, .omui-dialog, .modal, [role="dialog"]');
      if (!dlg) return { ok: false, reason: 'no-dlg' };
      const btns = [...dlg.querySelectorAll('button')];
      // 优先 primary + 文本确认/确定/保存
      let btn = btns.find((b) => /^(确认|确定|保存|提交)$/.test((b.innerText || '').trim()) && /primary/.test(b.className || ''));
      if (!btn) btn = btns.find((b) => /^(确认|确定|保存|提交)$/.test((b.innerText || '').trim()));
      if (!btn) return { ok: false, reason: 'no-btn', btnTexts: btns.map((b) => b.innerText.trim()).filter(Boolean) };
      btn.scrollIntoView();
      btn.click();
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return { ok: true, text: (btn.innerText || '').trim(), cls: btn.className };
    });
    if (forced.ok) log(`  → 确认按钮已 evaluate-click（${forced.text}，${forced.cls}）`);
    else log(`⚠ 兜底也未找到确认按钮：${forced.reason}`);
  }
  // 等弹窗关闭（最多 3 秒），并轮询验证
  let closed = false;
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(200);
    const stillOpen = await page.evaluate(() => {
      const d = document.querySelector('.omui-dialog-wrapper.open');
      return !!d;
    });
    if (!stillOpen) { closed = true; break; }
  }
  if (closed) log(`✓ 已确认「${field.label}」（弹窗已关闭）`);
  else log(`⚠ 已点击确认，但弹窗仍未关闭，请检查是否被遮挡`);
  return closed;
}

/**
 * 填内联单选组（如大鱼号「信息来源」）：
 * 直接在页面上找含选项文字的 ant-design radio/label 并点击（无弹窗）
 */
// 精确校验某选项的 ant-design 选中态（限定 wrapper 自身文本，避免误匹配大容器）
async function radioChecked(page, value) {
  return page.evaluate((val) => {
    const wraps = [...document.querySelectorAll('label.ant-radio-wrapper, .ant-radio-button-wrapper')];
    const hit = wraps.find((w) => (w.innerText || '').trim().includes(val));
    return !!(hit && (hit.querySelector('.ant-radio-checked, .ant-radio-button-checked, input:checked')));
  }, value);
}

async function fillInlineRadio(page, field, value, log) {
  if (!value) return false;
  // 定位含 field.label 的区块，避免误点其他单选组
  const groupSelectors = [
    // 大鱼号：信息来源区块内 .ant-radio-wrapper
    `div:has(> .ant-radio-wrapper):has-text("${field.label}")`,
    `.ant-radio-group:has-text("${value}")`,
  ];
  let scope = null;
  for (const sel of groupSelectors) {
    const loc = page.locator(sel).first();
    if (await loc.count().catch(() => 0)) { scope = loc; break; }
  }
  // 在整个页面找含选项文字的 radio（label 文字包含 value）
  const radio = (scope || page)
    .locator('.ant-radio-wrapper, .ant-radio-button-wrapper, label')
    .filter({ hasText: value })
    .first();
  try {
    if (!(await radio.count())) {
      log(`⚠ 未找到「${field.label}」的「${value}」选项，请手动选择`);
      return false;
    }
    await radio.scrollIntoViewIfNeeded().catch(() => {});
    // 第一次点 wrapper
    await radio.click({ force: true });
    await page.waitForTimeout(400);
    let checked = await radioChecked(page, value);
    // 未选中则重试：JS 直接点内部 input（防固定底栏/遮罩吞掉坐标点击）
    if (!checked) {
      await page.evaluate((val) => {
        const wraps = [...document.querySelectorAll('label.ant-radio-wrapper, .ant-radio-button-wrapper')];
        const hit = wraps.find((w) => (w.innerText || '').trim().includes(val));
        if (hit) { const input = hit.querySelector('input'); if (input) input.click(); }
      }, value).catch(() => {});
      await page.waitForTimeout(400);
      checked = await radioChecked(page, value);
    }
    if (checked) log(`✓ 已选择「${field.label}」：${value}`);
    else log(`⚠ 已点击「${field.label}」的「${value}」，但未检测到选中态，请核对`);
    return checked;
  } catch (e) {
    log(`⚠ 选择「${field.label}」失败：${e.message}，请手动处理`);
    return false;
  }
}

async function fillExtraFields(page, platform, extra, log) {
  for (const field of platform.extraFields || []) {
    const value = (extra || {})[field.key] || field.defaultValue;
    if (!value) continue;
    if (field.type === 'select') await fillSelect(page, field, value, log);
    else if (field.type === 'tags') await fillTags(page, field, value, log);
    else if (field.type === 'radio') await fillDeclaration(page, field, value, log);
    else if (field.type === 'inline-radio') await fillInlineRadio(page, field, value, log);
    else if (field.type === 'textarea') await fillDeclaration(page, field, value, log);
    else {
      const loc = await firstMatch(page, field.selectors, { timeout: 2500 });
      if (loc) {
        await loc.fill(value);
        log(`✓ 已填写「${field.label}」：${value}`);
      } else log(`⚠ 未找到「${field.label}」输入框`);
    }
  }
}

/**
 * 关掉可能残留的弹窗（如大鱼号封面「从正文选择」向导、ant-modal 等），
 * 避免弹窗盖住「发表」按钮导致自动发布点不到。best-effort，关不掉也不抛错。
 */
async function closeStrayDialogs(page, log) {
  try {
    // 找当前可见的弹窗（widgets-pop / ant-modal / omui-dialog / [role=dialog]）
    const dlg = page
      .locator('.widgets-pop, .ant-modal, .omui-dialog-wrapper.open, .omui-dialog, .modal, [role="dialog"]')
      .filter({ hasText: /封面|正文|上传|取消|下一步|确定|保存/ })
      .last();
    if (!(await dlg.count())) {
      return false;
    }
    // 优先点「取消」；没有则点 footer 里的 default 按钮；最后点右上角关闭
    const cancel = dlg.locator('button:has-text("取消")').first();
    if (await cancel.count()) {
      await cancel.click({ force: true }).catch(() => {});
    } else {
      const x = dlg.locator('[class*="close"], .ant-modal-close, .anticon-close').first();
      if (await x.count()) await x.click({ force: true }).catch(() => {});
      else {
        const def = dlg.locator('button.w-btn_default, button:not(.w-btn_primary)').first();
        if (await def.count()) await def.click({ force: true }).catch(() => {});
      }
    }
    await page.waitForTimeout(800);
    const stillOpen = await page.evaluate(() =>
      !!document.querySelector('.widgets-pop, .ant-modal, .omui-dialog-wrapper.open, [role="dialog"]:not([style*="display: none"])'));
    if (!stillOpen) log('✓ 已自动关闭残留的封面/弹窗');
    return !stillOpen;
  } catch {
    return false;
  }
}

/** 关闭「文内图片」对话框（正文插图弹窗）。封面弹窗由 uploadCover 处理，这里不碰。 */async function dismissImageDialog(page, log) {
  try {
    // 仅匹配「文内图片」tab 为主要特征的弹窗（omui-dialog / .modal / [role=dialog]）
    const dlg = page
      .locator('.omui-dialog-wrapper.open, .omui-dialog, .modal, [role="dialog"]')
      .filter({ hasText: /文内图片/ })
      .first();
    if (!(await dlg.count())) return false;
    // 优先点「取消」，再点右上角关闭
    const cancel = dlg.locator('button:has-text("取消")').first();
    if (await cancel.count()) {
      await cancel.click({ force: true }).catch(() => {});
    } else {
      const close = dlg.locator('.omui-dialog-close, [class*="dialog-close"], [class*="close"]').first();
      if (await close.count()) await close.click({ force: true }).catch(() => {});
    }
    await page.waitForTimeout(600);
    log('✓ 已自动关闭「文内图片」对话框（正文中的图片需在发文页手动上传）');
    return true;
  } catch {
    return false;
  }
}

// ---------- 大鱼号专属封面流程 ----------
/**
 * 大鱼号封面逻辑与企鹅号完全不同：封面必须从「正文」中的图片里选。
 * 流程：把封面图粘贴进正文（触发编辑器真实上传，得到服务端图片 URL）
 *       → 点「设置封面」打开「从正文中选择」向导
 *       → 鼠标点选图片 → 下一步 → 保存。
 * 支持单封面 / 三封面：三封面复用同一张图填满 3 个槽位（正文只插一张，避免重复图）。
 * 返回 true=已设置成功（或无需封面）。
 */
async function dayuCoverFlow(page, platform, article, extra, log) {
  const coverPath = article.coverPath;
  if (!coverPath || !fs.existsSync(coverPath)) {
    log('未检测到封面图，跳过封面设置（大鱼号封面需从正文选图，建议为稿件配置封面）');
    return false;
  }
  // 封面形式锁死单封面（三封面后续再设计），忽略外部传入的其他模式
  const coverMode = '单封面';
  const slots = 1;

  // 1) 把封面图粘贴进正文（ClipboardEvent 在 UEditor 帧内构造，触发真实上传）
  // 定位长文编辑器帧：跳过主帧，找含 contenteditable 的 iframe（与 fillContent 同样策略）
  let frame = null;
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    try {
      const ed = f.locator('body[contenteditable="true"], [contenteditable="true"]').first();
      if (await ed.count()) { frame = f; break; }
    } catch { /* try next */ }
  }
  if (!frame) { log('⚠ 未找到长文编辑器 iframe，封面无法自动设置'); return false; }

  // 光标移到正文末尾，再粘贴（把封面放在文中合适的位置：末尾）
  await frame.locator('body').click().catch(() => {});
  await frame.evaluate(() => {
    const sel = window.getSelection ? window.getSelection() : null;
    if (sel && document.body) {
      const range = document.createRange();
      range.selectNodeContents(document.body);
      range.collapse(false); // 折叠到末尾
      sel.removeAllRanges();
      sel.addRange(range);
    }
    document.execCommand('insertHTML', false, '<p></p>');
  });
  const b64 = fs.readFileSync(coverPath).toString('base64');
  const dt = await frame.evaluateHandle((b) => {
    const dt = new DataTransfer();
    const bytes = Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
    dt.items.add(new File([bytes], 'cover.jpg', { type: 'image/jpeg' }));
    return dt;
  }, b64);
  await frame.evaluate((dt) => {
    const e = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    (document.activeElement || document.body).dispatchEvent(e);
  }, dt);
  await page.waitForTimeout(2500);
  log('✓ 封面图已写入正文（从正文中选择封面的前提）');

  // 2) 选封面形式
  if (platform.coverMode) {
    // 注意：必须点选项内的 `.w-radio` 才会切换（点外层 `.normal-option` 无效，Vue 不切换）
    const modeBtn = page
      .locator('.article-write-article-cover_normal-option')
      .filter({ hasText: coverMode })
      .locator('.w-radio')
      .first();
    if (await modeBtn.count()) await modeBtn.click({ force: true }).catch(() => {});
    await page.waitForTimeout(600);
  }

  // 3) 逐个槽位设置封面（单/三封面通用，规避自动填充的异步时序）
  // 关键发现：
  //   - 切到任一封面模式后，大鱼号会**异步**用正文第一张图自动填充槽 1 → 槽 1 内出现 <img>
  //   - 三封面：槽 2/3 显示「设置封面」；填满前 2 槽后，最后一槽的触发器会从「设置封面」
  //     (.cover-item_set) 切换为「从正文中选择」按钮 (.cover-item_choose > button)，且 set 变零尺寸
  //   - 因此：切换后先等自动填充完成；每个槽位若已有 <img> 就跳过（计为已填）；
  //     否则优先点 .cover-item_set，不可用时回退同槽 .cover-item_choose > button。
  let setCount = 0;
  try {
    if (platform.coverMode) await page.waitForTimeout(1500); // 等自动填充渲染出槽 1 的图
    const items = page.locator('.article-write-article-cover_normal-items > .article-write-article-cover_normal-item');
    const totalSlots = await items.count();
    for (let i = 0; i < totalSlots && setCount < slots; i++) {
      const itemLoc = items.nth(i);
      // 槽内已有图 → 已被自动填充/已设置，跳过并计为已填
      if (await itemLoc.locator('img').count()) { log(`· 第 ${i + 1} 个封面框已有图（自动填充/已设置）`); setCount++; continue; }

      // 找触发器：优先「设置封面」，可用则点它；不可用则回退同槽「从正文中选择」按钮
      let clicked = false;
      const setEl = itemLoc.locator('.article-write-article-cover-cover-item_set');
      if (await setEl.count() && await setEl.first().isVisible().catch(() => false)) {
        await setEl.first().click({ force: true }); clicked = true;
      } else if (await itemLoc.locator('.article-write-article-cover-cover-item_choose button').count()) {
        await itemLoc.locator('.article-write-article-cover-cover-item_choose button').first().click({ force: true }); clicked = true;
      }
      if (!clicked) { log(`⚠ 第 ${i + 1} 个封面槽未找到可用入口`); continue; }
      await page.waitForTimeout(2500);

      // 向导里按槽位 index 选图（避免多图重复选同一张；越界回退到第一张）
      const box = await page.evaluate((idx) => {
        const imgs = document.querySelectorAll('.article-material-image_image img');
        if (!imgs.length) return null;
        const img = imgs[Math.min(idx, imgs.length - 1)];
        const r = img.getBoundingClientRect();
        return r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
      }, i);
      if (!box) { log(`⚠ 第 ${i + 1} 个封面槽未在正文中找到可用图片`); await closeStrayDialogs(page, log); continue; }

      // 点击图片触发选中态（橙色对勾）
      await page.mouse.click(box.x, box.y);
      await page.waitForTimeout(800);

      // 下一步 → 保存
      await page.locator('.widgets-pop button').filter({ hasText: '下一步' }).first().click({ force: true }).catch(() => {});
      await page.waitForTimeout(2500);
      await page.locator('.widgets-pop button').filter({ hasText: '保存' }).first().click({ force: true }).catch(() => {});
      await page.waitForTimeout(2500);

      const closed = await page.evaluate(() => !document.querySelector('.widgets-pop'));
      setCount++;
      log(`✓ 已设置第 ${setCount}/${slots} 个封面框`);
      if (!closed) { await closeStrayDialogs(page, log); break; }
    }
  } catch (e) {
    log(`⚠ 封面设置中断：${e.message}`);
    await closeStrayDialogs(page, log).catch(() => {});
  }
  return setCount > 0;
}

// ---------- 单平台发布 ----------
async function publishToPlatform(record, platformId, article, mode, extra) {
  const entry = record.platforms.find((p) => p.platform === platformId);
  const platform = getPlatform(platformId);
  const log = (msg) => {
    entry.logs.push({ t: ts(), msg });
    store.saveRecord(record);
    console.log(`[${platform.name}] ${msg}`);
  };

  entry.status = 'running';
  store.saveRecord(record);

  try {
    if (!platform.publishUrl) {
      throw new Error('未配置发文页地址，请在「平台设置」中填写该平台发文页 URL');
    }

    // 平台不支持 headless（如 CSDN 编辑器在隐私模式下拒绝加载）时，
    // 禁止走 auto（无头）模式，强制回落到 confirm（有头）模式，否则会在无头窗口里静默失败。
    if (mode === 'auto' && platform.headlessUnsupported) {
      mode = 'confirm';
      log('该平台编辑器不支持无头模式，已自动切换为「预填确认」模式');
    }

    // confirm（预填待确认）→ 弹出可见窗口，用户能看着机器人操作、最后自己点「发表」；
    // auto（全自动）→ 后台无头，静默完成
    const ctx = await statusBot.getContext(platformId, { headless: mode === 'auto' });
    const page = await ctx.newPage();
    page.on('dialog', (d) => d.accept().catch(() => {}));

    log(`打开发文页 ${platform.publishUrl}`);
    await page.goto(platform.publishUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);

    // 登录检查
    const url = page.url();
    const onLoginPage = (platform.loginCheck?.loginUrlFragments || ['login']).some((f) =>
      url.includes(f)
    );
    if (onLoginPage) {
      entry.status = 'failed';
      entry.error = '登录态失效，请到「账号管理」重新登录';
      log('✗ 登录态失效');
      return;
    }

    // 实名认证/资质审核中间页检测
    const verifyKeywords = platform.loginCheck?.verifyKeywords || [];
    if (verifyKeywords.length) {
      const pageText = (await page.evaluate(() => document.body?.innerText || '')).slice(0, 4000);
      const hit = verifyKeywords.find((k) => pageText.includes(k));
      if (hit) {
        entry.status = 'failed';
        entry.error = `检测到「${hit}」中间页（账号未通过平台资质/实名审核），请到 om.qq.com 完成认证后再发稿`;
        log(`✗ 检测到中间页关键词「${hit}」，账号可能未通过平台审核，脚本无法代为处理`);
        return;
      }
    }

    // 填表
    await fillTitle(page, platform, article.title, log);
    await page.waitForTimeout(800);
    await fillContent(page, platform, article.html, log);
    await page.waitForTimeout(1200);
    await dismissImageDialog(page, log); // 正文含图片可能弹「文内图片」框（正文插图弹窗），自动关闭
    await page.waitForTimeout(500);
    // 封面：各平台逻辑不同，独立分发
    //  - 大鱼号：从正文选图向导（dayuCoverFlow）
    //  - 其余平台：通用 filechooser + 弹窗上传通道
    //  - 网易号已废除自动发稿（反 headless + session 短期），不参与分发
    if (platform.id === 'dayu') {
      await dayuCoverFlow(page, platform, article, extra, log);
    } else {
      await uploadCover(page, platform, article.coverPath || null, log); // 上传封面（切「本地上传」tab → 传文件 → 确认）
    }
    await closeStrayDialogs(page, log); // 兜底关掉残留封面/弹窗，避免挡住「发表」
    await page.waitForTimeout(600);
    await fillExtraFields(page, platform, extra, log);

    if (mode === 'auto') {
      log('尝试自动点击发布…');
      const btn = await findPublishBtn(page, platform);
      if (!btn) {
        entry.status = 'confirm';
        log('⚠ 未找到发布按钮，已停在发文页，请人工确认发布');
        return;
      }
      await btn.click();
      await page.waitForTimeout(6000);
      const afterUrl = page.url();
      if (afterUrl !== url || /success|result|manage|list/i.test(afterUrl)) {
        entry.status = 'success';
        entry.publishStatus = 'auditing'; // 已提交，进入平台审核
        entry.publishStatusAt = new Date().toISOString();
        log('✓ 已提交发布，进入审核（请稍后在「发布记录」跟进状态）');
      } else {
        entry.status = 'confirm';
        log('⚠ 已点击发布，但页面未跳转，可能存在二次确认弹窗；后台无头窗口无法人工处理，建议改用「预填确认」模式重试');
      }
    } else {
      // 确认模式：把发布按钮滚到视口内并高亮，方便用户直接点击
      await findPublishBtn(page, platform).catch(() => {});
      entry.status = 'confirm';
      entry.finalUrl = page.url();
      const btnWord = platform.selectors.publishBtnText?.[0] || '发布';
      log(`✓ 预填完成，已弹出浏览器窗口，请在窗口底部点击「${btnWord}」`);
    }
  } catch (e) {
    entry.status = 'failed';
    entry.error = e.message;
    log(`✗ 发布失败：${e.message}`);
  } finally {
    entry.finishedAt = new Date().toISOString();
    store.saveRecord(record);
  }
}

// ---------- 任务调度 ----------
const running = new Set(); // platformId，同平台串行
const queues = new Map();

function enqueue(record, platformId, article, mode, extra) {
  if (!queues.has(platformId)) queues.set(platformId, []);
  queues.get(platformId).push({ record, article, mode, extra });
  drain(platformId);
}

async function drain(platformId) {
  if (running.has(platformId)) return;
  const q = queues.get(platformId);
  const item = q.shift();
  if (!item) return;
  running.add(platformId);
  try {
    await publishToPlatform(item.record, platformId, item.article, item.mode, item.extra);
  } finally {
    running.delete(platformId);
    if (queues.get(platformId).length) drain(platformId);
  }
}

/**
 * 发起一次发布任务（多平台并行、单平台内串行）
 * extra: { qq: {category, tags}, netease: {...} } 各平台补充字段
 * @returns record
 */
function startJob({ article, platformIds, mode = 'confirm', extra = {} }) {
  const record = {
    id: store.uid('rec'),
    articleId: article.id,
    articleTitle: article.title,
    mode,
    createdAt: new Date().toISOString(),
    platforms: platformIds.map((pid) => ({
      platform: pid,
      name: getPlatform(pid)?.name || pid,
      status: 'pending',
      publishStatus: null, // 平台侧审核状态（auditing/published/rejected/scheduled/offline/draft）
      publishStatusAt: null,
      mediaUrl: null, // 发布后在平台侧的稿件链接（状态机器人抓取回填）
      logs: [],
    })),
  };
  store.saveRecord(record);
  for (const pid of platformIds) enqueue(record, pid, article, mode, extra[pid] || {});
  return record;
}

// ---------- 发布状态跟进 ----------
const PLATFORM_STATUS = {
  '审核中': 'auditing',
  '已发布': 'published',
  '待发布': 'scheduled',
  '未通过': 'rejected',
  '审核失败': 'rejected',
  '审核不通过': 'rejected',
  '发布失败': 'rejected',
  '已下线': 'offline',
  '已下架': 'offline',
  '草稿': 'draft',
};

const STATUS_LABEL = {
  auditing: '审核中',
  published: '审核通过',
  scheduled: '待发布',
  rejected: '审核未通过',
  offline: '已下线',
  draft: '草稿',
};
const STATUS_KEYWORDS = /^(已发布|审核中|待发布|未通过|草稿|审核失败|审核不通过|已下线|已下架)$/;

/** 抓取平台内容管理列表，返回 [{title, status, time}]（status 为平台原文） */
async function fetchPlatformStatus(platform, log) {
  const statusUrl = platform.statusUrl;
  if (!statusUrl) return [];
  const ctx = await statusBot.getContext(platform.id);
  const page = await ctx.newPage();
  try {
    await page.goto(statusUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4500);
    const cards = await page.evaluate((kw) => {
      const re = new RegExp(kw);
      const out = [];
      for (const st of [...document.querySelectorAll('[class*="greyitem"]')]) {
        const statusText = (st.innerText || '').trim();
        if (!re.test(statusText)) continue;
        let card = st;
        for (let i = 0; i < 8; i++) {
          card = card.parentElement;
          if (!card) break;
          if ((card.innerText || '').trim().length > 40) break;
        }
        if (!card) continue;
        const cardText = (card.innerText || '').trim();
        const titleEl = card.querySelector('a[href*="article"], [class*="title"], h3, h2, [class*="name"]') || card;
        const title = (titleEl.innerText || titleEl.textContent || '').trim().slice(0, 90);
        const timeMatch = cardText.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
        out.push({ title, status: statusText, time: timeMatch ? timeMatch[0] : '' });
      }
      return out;
    }, STATUS_KEYWORDS.source);
    return cards;
  } catch (e) {
    log?.(`⚠ 抓取发布状态失败：${e.message}`);
    return [];
  } finally {
    if (!page.isClosed()) await page.close().catch(() => {});
  }
}

/** 用标题在抓取结果里模糊匹配同一篇稿件（平台可能截断标题加省略号） */
function matchByTitle(articleTitle, statusList) {
  const a = (articleTitle || '').replace(/[\s.…·_·-]+/g, '').toLowerCase();
  if (!a) return null;
  let best = null;
  let bestK = -1;
  for (const s of statusList) {
    const b = (s.title || '').replace(/[\s.…·_·-]+/g, '').toLowerCase();
    let k = 0;
    while (k < a.length && k < b.length && a[k] === b[k]) k++;
    if (k >= 10 && k > bestK) {
      bestK = k;
      best = s;
    }
  }
  return best;
}

/** 同步某条发布记录里所有平台的状态（抓取内容管理列表，按标题匹配后回写 publishStatus）
 *  抓取走独立 headless 机器人通道（lib/bot.js），与用户 headed Chrome 完全隔离。
 *  机器人未登录时返回空并在对应 entry 日志里提示用户去扫码。
 */
async function syncRecordStatus(record) {
  for (const entry of record.platforms) {
    const platform = getPlatform(entry.platform);
    if (!platform || !platform.statusUrl) continue;
    if (entry.status === 'failed') continue; // 已失败的不追状态
    let r;
    try {
      r = await statusBot.fetchStatusList(platform);
    } catch (e) {
      entry.logs.push({ t: ts(), msg: `⚠ 状态机器人抓取异常：${e.message}` });
      store.saveRecord(record);
      continue;
    }
    if (!r.ok) {
      const reason = r.reason || '未知错误';
      // 未登录场景：在 entry 上提示一次（避免每 2 分钟重复刷屏）
      if (!entry._statusBotLoginNotified) {
        entry._statusBotLoginNotified = true;
        entry.logs.push({ t: ts(), msg: `⚠ 状态机器人未就绪（${reason}），请到「账号管理」为状态机器人扫码登录后即可自动跟进` });
      }
      continue;
    }
    const list = r.items || [];
    if (!list.length) continue;
    const hit = matchByTitle(record.articleTitle, list);
    if (!hit) continue;
    const mapped = PLATFORM_STATUS[hit.status] || 'auditing';
    const changed = entry.publishStatus !== mapped;
    entry.publishStatus = mapped;
    entry.publishStatusAt = new Date().toISOString();
    if (hit.url) {
      // 优先用「公开可分享」链接（如 page.om.qq.com/page/）覆盖旧的临时/需登录链接
      const preferPublic = hit.url.includes('page.om.qq.com');
      const oldIsPublic = entry.mediaUrl && entry.mediaUrl.includes('page.om.qq.com');
      if (!entry.mediaUrl || (preferPublic && !oldIsPublic)) entry.mediaUrl = hit.url;
    }
    if (changed) {
      entry.logs.push({ t: ts(), msg: `📌 状态跟进：${STATUS_LABEL[mapped] || mapped}` });
      console.log(`[${platform.name}] 状态跟进 → ${STATUS_LABEL[mapped] || mapped}`);
    }
    store.saveRecord(record);
  }
  return record;
}

module.exports = { listPlatforms, getPlatform, startJob, firstMatch, uploadCover, dismissImageDialog, closeStrayDialogs, dayuCoverFlow, fillExtraFields, fillSelect, fillTags, fillDeclaration, fillInlineRadio, fetchPlatformStatus, matchByTitle, syncRecordStatus, STATUS_LABEL };
