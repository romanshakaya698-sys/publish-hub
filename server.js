/**
 * PublishHub —— 自媒体多平台一键发稿（本地版）
 * 启动：npm start  →  浏览器访问 http://localhost:3789
 */
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const store = require('./lib/store');
const { parseDocument, removeFirstHeading } = require('./lib/doc-parser');
const browser = require('./lib/browser');
const bot = require('./lib/bot');
const publisher = require('./lib/publisher');

const app = express();
const PORT = process.env.PORT || 3789;

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(store.UPLOAD_DIR));

// ---------- 上传配置 ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, store.UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['.docx', '.md', '.markdown', '.txt', '.html', '.htm', '.png', '.jpg', '.jpeg', '.gif', '.webp'];
    cb(null, ok.includes(path.extname(file.originalname).toLowerCase()));
  },
});

// 调试：用机器人（headless）打开发文页，dump 可交互元素 + 页面文本摘要
// 新平台开发第一步：先看登录态 + 有哪些输入框/按钮，再写选择器
app.post('/api/debug/bot-dom/:id', async (req, res) => {
  const platform = publisher.getPlatform(req.params.id);
  if (!platform) return res.status(404).json({ error: '平台不存在' });
  const target = (req.body && req.body.url) || platform.publishUrl;
  try {
    const ctx = await bot.getContext(platform.id, { headless: true });
    const page = await ctx.newPage();
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);
    const url = page.url();
    const data = await page.evaluate(() => {
      const out = {};
      out.url = location.href;
      out.title = document.title;
      out.bodyText = (document.body?.innerText || '').replace(/\n{2,}/g, '\n').slice(0, 1500);
      out.elements = [...document.querySelectorAll('input,textarea,[contenteditable="true"],select,button,[role="button"],a')]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 || r.height > 0;
        })
        .slice(0, 120)
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          type: el.type || '',
          id: el.id || '',
          cls: (el.className || '').toString().slice(0, 100),
          ph: el.placeholder || el.getAttribute('data-placeholder') || '',
          name: el.name || '',
          href: el.getAttribute('href') || '',
          edt: el.getAttribute('contenteditable') || '',
          txt: (el.innerText || el.value || '').trim().slice(0, 40),
        }));
      out.iframes = [...document.querySelectorAll('iframe')].map((f) => ({ src: f.src, id: f.id, cls: f.className }));
      return out;
    });
    await page.close().catch(() => {});
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 调试：抓取发文页上可见的可输入/可点击元素，用于精确定位选择器
app.post('/api/debug/elements/:id', async (req, res) => {
  const platform = publisher.getPlatform(req.params.id);
  if (!platform) return res.status(404).json({ error: '平台不存在' });
  try {
    const ctx = await browser.getContext(platform.id);
    const page = await ctx.newPage();
    await page.goto(platform.publishUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000);
    const url = page.url();
    const items = await page.evaluate(() => {
      const out = [];
      const sel = 'input,textarea,[contenteditable="true"],select,button';
      document.querySelectorAll(sel).forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        out.push({
          tag: el.tagName.toLowerCase(),
          type: el.type || '',
          id: el.id || '',
          cls: (el.className || '').toString().slice(0, 90),
          ph: el.placeholder || '',
          name: el.name || '',
          edt: el.getAttribute('contenteditable'),
          txt: (el.innerText || el.value || '').trim().slice(0, 30),
        });
      });
      return out.slice(0, 100);
    });
    await page.close().catch(() => {});
    res.json({ url, count: items.length, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// dump「添加封面」弹窗 DOM（复用已打开的浏览器窗口）
// 探测「分类/标签/声明」附加字段的真实 DOM
app.post('/api/debug/extra/:id', async (req, res) => {
  const platform = publisher.getPlatform(req.params.id);
  if (!platform) return res.status(404).json({ error: '平台不存在' });
  try {
    const ctx = await browser.getContext(platform.id);
    const page = await ctx.newPage();
    await page.goto(platform.publishUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);
    const data = await page.evaluate(() => {
      const out = {};
      // 0) 分类区域：找「请选择分类」所在容器，再找其内的输入框
      const catLabel = [...document.querySelectorAll('*')].find((el) => (el.innerText || '').trim() === '请选择分类');
      let catWrap = null;
      if (catLabel) {
        let p = catLabel.parentElement;
        for (let k = 0; k < 6 && p; k++, p = p.parentElement) {
          if (p.querySelector('input')) { catWrap = p; break; }
        }
      }
      out.categoryWrap = catWrap ? {
        tag: catWrap.tagName.toLowerCase(),
        cls: (catWrap.className || '').toString().slice(0, 100),
        innerHTML: catWrap.outerHTML.slice(0, 1500),
      } : 'NOT-FOUND';
      // 1) 所有 input.omui-suggestion__value（看有几个、每个的上下文）
      const sv = [...document.querySelectorAll('input.omui-suggestion__value')].map((el, i) => {
        const wrap = el.closest('.omui-form__group, .omui-form, [class*="suggestion"]') || el.parentElement;
        return {
          i,
          placeholder: el.placeholder || '',
          parentText: (wrap?.innerText || '').trim().slice(0, 60),
          parentCls: (wrap?.className || '').toString().slice(0, 100),
        };
      });
      out.sv = sv;
      // 2) 「标签」二字周围结构
      const tagLabel = [...document.querySelectorAll('*')].find((el) => (el.innerText || '').trim() === '标签');
      let tagWrap = null;
      if (tagLabel) {
        let p = tagLabel.parentElement;
        for (let k = 0; k < 6 && p; k++, p = p.parentElement) {
          if (p.querySelector('input')) { tagWrap = p; break; }
        }
      }
      out.tagWrap = tagWrap ? {
        tag: tagWrap.tagName.toLowerCase(),
        cls: (tagWrap.className || '').toString().slice(0, 100),
        innerHTML: tagWrap.outerHTML.slice(0, 1500),
      } : 'NOT-FOUND';
      // 3) 「添加内容自主声明」按钮的精确结构
      const declBtn = [...document.querySelectorAll('button')].find((el) => (el.innerText || '').trim() === '添加内容自主声明');
      out.declBtn = declBtn ? {
        cls: (declBtn.className || '').toString().slice(0, 120),
        id: declBtn.id || '',
      } : 'NOT-FOUND';
      out.url = location.href;
      return out;
    });
    await page.close().catch(() => {});
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 在 server 进程内直接试填附加字段并返回日志（方便端到端验证）
app.post('/api/debug/run-extra/:id', async (req, res) => {
  const platform = publisher.getPlatform(req.params.id);
  if (!platform) return res.status(404).json({ error: '平台不存在' });
  const extra = req.body || {};
  const logs = [];
  const log = (m) => { logs.push(m); console.log('[run-extra]', m); };
  try {
    const ctx = await browser.getContext(platform.id);
    const page = await ctx.newPage();
    await page.goto(platform.publishUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4500);
    // 先打开分类下拉
    const cat = page.locator('input.omui-suggestion__value').first();
    await cat.scrollIntoViewIfNeeded().catch(() => {});
    await cat.click({ force: true });
    await page.waitForTimeout(1500);
    const dump = await page.evaluate(() => {
      const dlg = document.querySelector('.omui-suggestion__dropdown-wrap');
      const opts = dlg ? [...dlg.querySelectorAll('.omui-suggestion__option')].map((o) => (o.innerText || '').trim()) : [];
      return { dropdownVisible: !!dlg, dropdownDisplay: dlg?.style.display, optCount: opts.length, optSample: opts.slice(0, 30), hasKeJi: opts.includes('科技') };
    });
    logs.push('DUMP: ' + JSON.stringify(dump));
    await publisher.fillExtraFields(page, platform, extra, log);
    await page.close().catch(() => {});
    res.json({ logs });
  } catch (e) {
    res.status(500).json({ error: e.message, logs });
  }
});
app.post('/api/debug/dump-dialog/:id', async (req, res) => {
  const platform = publisher.getPlatform(req.params.id);
  if (!platform) return res.status(404).json({ error: '平台不存在' });
  try {
    const ctx = await browser.getContext(platform.id);
    const page = await ctx.newPage();
    await page.goto(platform.publishUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4500);
    // 找自主声明触发按钮
    const declField = (platform.extraFields || []).find((f) => f.key === 'declaration' || f.type === 'radio');
    const trigger = declField
      ? await publisher.firstMatch(page, declField.triggerSelectors || [], { timeout: 3000 })
      : null;
    if (trigger) {
      await trigger.click({ force: true });
      await page.waitForTimeout(1500);
    }
    const data = await page.evaluate(() => {
      const dlg = document.querySelector('.omui-dialog-wrapper.open, .omui-dialog, .modal, [role="dialog"]');
      if (!dlg) return { dialogFound: false };
      // 找所有 button + role=button
      const btns = [...dlg.querySelectorAll('button, [role="button"], .omui-button')]
        .map((b) => ({
          tag: b.tagName.toLowerCase(),
          cls: (b.className || '').toString().trim().slice(0, 200),
          text: (b.innerText || '').trim().slice(0, 30),
          aria: b.getAttribute('aria-label') || '',
          type: b.getAttribute('type') || '',
          disabled: b.disabled || b.getAttribute('disabled') !== null,
        }));
      // 找所有可能选项元素
      const candidates = [
        ...dlg.querySelectorAll('.omui-radio, .omui-radio-wrapper, .omui-radio-button-wrapper, .omui-checkbox, .omui-checkbox-wrapper, label, [role="radio"], [role="option"], select option, li'),
      ].map((el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return {
          tag: el.tagName.toLowerCase(),
          cls: (el.className || '').toString().trim().slice(0, 120),
          text: (el.innerText || el.textContent || '').trim().slice(0, 40),
          textExact: (el.textContent || '').trim().slice(0, 40),
          visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
          size: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
          parent: (el.parentElement?.className || '').toString().trim().slice(0, 60),
        };
      }).filter((c) => c.text);
      // 找 select 下拉
      const selects = [...dlg.querySelectorAll('select, [class*="select"], [class*="dropdown"], [class*="Select"], [class*="Dropdown"]')].map((el) => ({
        tag: el.tagName.toLowerCase(),
        cls: (el.className || '').toString().trim().slice(0, 120),
        childCount: el.children.length,
        text: (el.innerText || '').trim().slice(0, 60),
      }));
      // 找 footer
      const footer = dlg.querySelector('.omui-dialog-footer, [class*="footer"], [class*="Footer"]');
      const footerBtns = footer ? [...footer.querySelectorAll('button')].map((b) => ({
        cls: (b.className || '').toString().trim().slice(0, 200),
        text: (b.innerText || '').trim().slice(0, 30),
      })) : [];
      return {
        dialogFound: true,
        dialogTextHead: (dlg.innerText || '').trim().slice(0, 200),
        candidateCount: candidates.length,
        candidates: candidates.slice(0, 30),
        selectCount: selects.length,
        selects,
        btnCount: btns.length,
        btns,
        footerFound: !!footer,
        footerBtns,
      };
    });
    await page.close().catch(() => {});
    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/debug/cover/:id', async (req, res) => {
  const platform = publisher.getPlatform(req.params.id);
  if (!platform) return res.status(404).json({ error: '平台不存在' });
  let clickErr = null;
  try {
    const ctx = await browser.getContext(platform.id);
    const page = await ctx.newPage();
    await page.goto(platform.publishUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000);
    // 点「添加封面」
    const trigger = await publisher.firstMatch(page, platform.selectors.coverTrigger, { timeout: 5000 });
    if (!trigger) return res.status(400).json({ error: '未找到「添加封面」入口' });
    await trigger.click().catch((e) => { clickErr = e.message; });
    await page.waitForTimeout(3000);
    // dump 当前弹窗 + 文件控件
    const data = await page.evaluate(() => {
      const dlg = document.querySelector('.omui-dialog-wrapper.open, .omui-dialog, .modal, [role="dialog"]');
      const tab = dlg && [...dlg.querySelectorAll('*')].find((el) => (el.innerText || '').trim() === '本地上传');
      if (dlg && tab) (tab.closest('[class*="tab"],li,div,span,button') || tab).click();
      return {
        dialogText: dlg ? (dlg.innerText || '').trim().slice(0, 80) : 'NO-DLG',
        tabClicked: !!tab,
        fileInputs: [...document.querySelectorAll('input[type="file"]')].map((el) => ({
          cls: (el.className || '').toString().slice(0, 60), accept: el.accept || '',
        })),
        buttons: [...document.querySelectorAll('button')].map((b) => (b.innerText || '').trim()).filter(Boolean).slice(0, 40),
      };
    });
    await page.waitForTimeout(1200);
    const after = await page.evaluate(() => ({
      fileInputs: [...document.querySelectorAll('input[type="file"]')].map((el) => ({ accept: el.accept || '' })),
      dialogText: (document.querySelector('.omui-dialog-wrapper.open, .omui-dialog, .modal, [role="dialog"]')?.innerText || '').trim().slice(0, 100),
    }));
    await page.close().catch(() => {});
    res.json({ clickErr, data, after });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- 平台 ----------
app.get('/api/platforms', (req, res) => {
  res.json(
    publisher.listPlatforms().map((p) => ({
      id: p.id,
      name: p.name,
      site: p.site,
      loginUrl: p.loginUrl,
      publishUrl: p.publishUrl,
      contextOpen: browser.isContextOpen(p.id),
      extraFields: p.extraFields || [],
      coverMode: p.coverMode || null,
    }))
  );
});

// 调试：复用现有已打开的页面，dump「常用分类」快捷芯片的真实 DOM（不新开 tab）
app.post('/api/debug/category/:id', async (req, res) => {
  const platform = publisher.getPlatform(req.params.id);
  if (!platform) return res.status(404).json({ error: '平台不存在' });
  try {
    const ctx = await browser.getContext(platform.id);
    const page = await ctx.newPage();
    await page.goto(platform.publishUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);
    const data = await page.evaluate(() => {
      // 找「请选择分类」的容器
      const catLabel = [...document.querySelectorAll('*')].find((el) => (el.innerText || '').trim() === '请选择分类');
      let catWrap = null;
      if (catLabel) {
        let p = catLabel.parentElement;
        for (let k = 0; k < 8 && p; k++, p = p.parentElement) {
          if (p.querySelector('input')) { catWrap = p; break; }
        }
      }
      const wrapHTML = catWrap ? catWrap.outerHTML : '';
      // 找「常用分类」文本所在行
      const freq = [...document.querySelectorAll('*')].filter((el) => (el.innerText || '').trim().startsWith('常用分类'));
      const freqItems = freq.slice(0, 3).map((el) => ({
        tag: el.tagName.toLowerCase(),
        cls: (el.className || '').toString().slice(0, 120),
        text: (el.innerText || '').trim().slice(0, 200),
        html: el.outerHTML.slice(0, 1600),
      }));
      // 找所有含「科技」的可点芯片（点击即可选分类）
      const chips = [...document.querySelectorAll('span, div, a, button, li')]
        .filter((el) => (el.innerText || '').trim() === '科技' && el.children.length === 0)
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          cls: (el.className || '').toString().slice(0, 120),
          text: (el.innerText || '').trim(),
          parentCls: (el.parentElement?.className || '').toString().slice(0, 120),
          grandParentCls: (el.parentElement?.parentElement?.className || '').toString().slice(0, 120),
          html: el.outerHTML.slice(0, 500),
        }));
      return { url: location.href, catWrapFound: !!catWrap, wrapHTML: wrapHTML.slice(0, 2000), freqItems, chips: chips.slice(0, 10) };
    });
    await page.close().catch(() => {});
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 更新平台设置（发文页地址等）
app.put('/api/platforms/:id', (req, res) => {
  const { publishUrl } = req.body || {};
  const settings = store.getSettings();
  if (!settings.platforms) settings.platforms = {};
  if (!settings.platforms[req.params.id]) settings.platforms[req.params.id] = {};
  if (typeof publishUrl === 'string') settings.platforms[req.params.id].publishUrl = publishUrl.trim();
  store.saveSettings(settings);
  res.json({ ok: true });
});

// ---------- 账号 ----------
// 打开登录窗口（异步执行，前端轮询状态）
const loginStates = new Map(); // platformId -> { status, logs }
app.post('/api/accounts/:id/login', async (req, res) => {
  const platform = publisher.getPlatform(req.params.id);
  if (!platform) return res.status(404).json({ error: '平台不存在' });
  const state = { status: 'waiting', logs: [] };
  loginStates.set(platform.id, state);
  browser
    .openLoginWindow(platform, {
      onLog: (m) => state.logs.push(m),
      onSuccess: () => (state.status = 'ok'),
    })
    .then((r) => {
      state.status = r.loggedIn ? 'ok' : r.closed ? 'closed' : 'timeout';
    })
    .catch((e) => {
      state.status = 'error';
      state.logs.push('错误：' + e.message);
    });
  res.json({ ok: true, message: `正在打开 ${platform.name} 登录窗口` });
});

// 登录流程状态（前端轮询）
app.get('/api/accounts/:id/login-status', (req, res) => {
  res.json(loginStates.get(req.params.id) || { status: 'idle', logs: [] });
});

// 检查登录态
app.post('/api/accounts/:id/check', async (req, res) => {
  const platform = publisher.getPlatform(req.params.id);
  if (!platform) return res.status(404).json({ error: '平台不存在' });
  try {
    const r = await browser.checkLogin(platform, platform.publishUrl);
    res.json(r);
  } catch (e) {
    res.json({ loggedIn: false, error: e.message });
  }
});

// ---------- 稿件 ----------
app.post('/api/articles/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '请选择文件' });
    const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(
      path.extname(req.file.originalname).toLowerCase()
    );
    if (isImage) return res.status(400).json({ error: '请上传稿件文档（docx/md/txt/html）' });

    const { title, html } = await parseDocument(req.file.path);
    // multer 对中文文件名默认按 latin1 解码，这里转回 UTF-8
    const sourceName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    const article = {
      id: store.uid('art'),
      title,
      // 正文去掉第一个大标题，避免与标题重复显示
      html: removeFirstHeading(html),
      coverPath: null,
      tags: [],
      sourceFile: sourceName,
      createdAt: new Date().toISOString(),
    };
    store.saveArticle(article);
    // 解析完删除临时 docx（图片已内联 base64）
    fs.unlink(req.file.path, () => {});
    res.json(article);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/articles', (req, res) => {
  res.json(store.listArticles());
});

app.get('/api/articles/:id', (req, res) => {
  const a = store.getArticle(req.params.id);
  if (!a) return res.status(404).json({ error: '稿件不存在' });
  res.json(a);
});

app.put('/api/articles/:id', (req, res) => {
  const a = store.getArticle(req.params.id);
  if (!a) return res.status(404).json({ error: '稿件不存在' });
  const { title, tags } = req.body || {};
  if (typeof title === 'string' && title.trim()) a.title = title.trim();
  if (Array.isArray(tags)) a.tags = tags.map((t) => String(t).trim()).filter(Boolean);
  store.saveArticle(a);
  res.json(a);
});

app.delete('/api/articles/:id', (req, res) => {
  store.deleteArticle(req.params.id);
  res.json({ ok: true });
});

// 上传/更换封面
app.post('/api/articles/:id/cover', upload.single('file'), (req, res) => {
  const a = store.getArticle(req.params.id);
  if (!a) return res.status(404).json({ error: '稿件不存在' });
  if (!req.file) return res.status(400).json({ error: '请选择图片' });
  a.coverPath = req.file.path;
  store.saveArticle(a);
  res.json({ ok: true, coverPath: a.coverPath });
});

// ---------- 发布 ----------
app.post('/api/publish', async (req, res) => {
  const { articleId, platforms: platformIds, mode, extra } = req.body || {};
  const article = store.getArticle(articleId);
  if (!article) return res.status(404).json({ error: '稿件不存在' });
  if (!Array.isArray(platformIds) || platformIds.length === 0) {
    return res.status(400).json({ error: '请选择至少一个平台' });
  }
  if (!['auto', 'confirm'].includes(mode)) {
    return res.status(400).json({ error: 'mode 必须为 auto 或 confirm' });
  }
  // 未配置发文页地址的平台直接拒绝
  const invalid = platformIds.filter((pid) => !publisher.getPlatform(pid)?.publishUrl);
  if (invalid.length) {
    return res.status(400).json({
      error: `以下平台未配置发文页地址：${invalid.join('、')}，请先在「平台设置」中填写`,
    });
  }
  const record = publisher.startJob({ article, platformIds, mode, extra });
  res.json(record);
});

app.get('/api/records', (req, res) => {
  res.json(store.listRecords().slice(0, 100));
});

app.get('/api/records/:id', (req, res) => {
  const r = store.getRecord(req.params.id);
  if (!r) return res.status(404).json({ error: '记录不存在' });
  res.json(r);
});

// 手动刷新某条记录的发布状态（抓取平台内容管理列表同步）
app.post('/api/records/:id/status', async (req, res) => {
  const r = store.getRecord(req.params.id);
  if (!r) return res.status(404).json({ error: '记录不存在' });
  try {
    await publisher.syncRecordStatus(r);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  res.json(r);
});

// 手动设置某条记录某平台的媒体链接（用户从企鹅号 App 复制粘贴 page.om.qq.com 公开链接）
app.put('/api/records/:id/:platform/media-url', (req, res) => {
  const r = store.getRecord(req.params.id);
  if (!r) return res.status(404).json({ error: '记录不存在' });
  const entry = (r.platforms || []).find((p) => p.platform === req.params.platform);
  if (!entry) return res.status(404).json({ error: '该平台不在本记录中' });
  const url = (req.body && typeof req.body.mediaUrl === 'string') ? req.body.mediaUrl.trim() : '';
  entry.mediaUrl = url || null;
  store.saveRecord(r);
  res.json(r);
});

// 编辑发布记录（稿件标题 / 日期时间 —— 同一篇稿件的所有平台行共享）
app.put('/api/records/:id', (req, res) => {
  const r = store.getRecord(req.params.id);
  if (!r) return res.status(404).json({ error: '记录不存在' });
  const { articleTitle, createdAt } = req.body || {};
  if (typeof articleTitle === 'string' && articleTitle.trim()) r.articleTitle = articleTitle.trim();
  if (typeof createdAt === 'string' && createdAt.trim()) {
    const d = new Date(createdAt);
    if (isNaN(d.getTime())) return res.status(400).json({ error: '日期时间格式不正确' });
    r.createdAt = d.toISOString();
  }
  store.saveRecord(r);
  res.json(r);
});

// 编辑某条记录中某平台行（媒体链接 / 平台侧发布状态）
const RECORD_PUBLISH_STATUS = ['auditing', 'published', 'scheduled', 'rejected', 'offline', 'draft'];
app.put('/api/records/:id/:platform', (req, res) => {
  const r = store.getRecord(req.params.id);
  if (!r) return res.status(404).json({ error: '记录不存在' });
  const entry = (r.platforms || []).find((p) => p.platform === req.params.platform);
  if (!entry) return res.status(404).json({ error: '该平台不在本记录中' });
  const { mediaUrl, publishStatus } = req.body || {};
  if (typeof mediaUrl === 'string') entry.mediaUrl = mediaUrl.trim() || null;
  if (typeof publishStatus === 'string') {
    if (publishStatus && !RECORD_PUBLISH_STATUS.includes(publishStatus)) {
      return res.status(400).json({ error: `publishStatus 只能是：${RECORD_PUBLISH_STATUS.join(' / ')} 或留空` });
    }
    entry.publishStatus = publishStatus || null;
    entry.publishStatusAt = publishStatus ? new Date().toISOString() : null;
  }
  store.saveRecord(r);
  res.json(r);
});

// 删除整条发布记录（该稿件的所有平台行）
app.delete('/api/records/:id', (req, res) => {
  if (!store.getRecord(req.params.id)) return res.status(404).json({ error: '记录不存在' });
  store.deleteRecord(req.params.id);
  res.json({ ok: true });
});

// 删除某条记录中的单个平台行；若平台行删完则整条记录一并删除
app.delete('/api/records/:id/:platform', (req, res) => {
  const r = store.getRecord(req.params.id);
  if (!r) return res.status(404).json({ error: '记录不存在' });
  r.platforms = (r.platforms || []).filter((p) => p.platform !== req.params.platform);
  if (!r.platforms.length) store.deleteRecord(r.id);
  else store.saveRecord(r);
  res.json({ ok: true, removed: r.platforms.length === 0 ? 'record' : 'platform' });
});

// ---------- 平台机器人（独立 headless 通道，统一管发稿和状态抓取） ----------
// 查看各平台机器人健康度（哪些已登录、哪些还待扫码、profile 在哪里）
app.get('/api/bot/status', (req, res) => {
  const out = {};
  for (const p of publisher.listPlatforms()) {
    out[p.id] = {
      name: p.name,
      profileDir: bot.profileDir(p.id),
      needsLogin: bot.needsLoginHeuristic(p.id),
      health: bot.listBotHealth()[p.id] || null,
    };
  }
  res.json(out);
});

// 为某个平台启动机器人扫码登录（弹出一次性 headed 窗口，用户扫码后自动切回 headless）
app.post('/api/bot/login/:platformId', async (req, res) => {
  const platform = publisher.getPlatform(req.params.platformId);
  if (!platform) return res.status(404).json({ error: '平台不存在' });
  try {
    const result = await bot.openLoginWindow(platform, {
      onLog: (m) => console.log(`[bot:${platform.id}] ${m}`),
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 测试一次状态抓取（不写记录，仅返回抓到的状态卡片，方便验证机器人是否正常）
app.post('/api/bot/probe-status/:platformId', async (req, res) => {
  const platform = publisher.getPlatform(req.params.platformId);
  if (!platform) return res.status(404).json({ error: '平台不存在' });
  try {
    const result = await bot.fetchStatusList(platform);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 测试机器人登录态：headless 打开发文页看是否被踢回登录页（不打发布）
app.post('/api/bot/probe-login/:platformId', async (req, res) => {
  const platform = publisher.getPlatform(req.params.platformId);
  if (!platform) return res.status(404).json({ error: '平台不存在' });
  try {
    const ctx = await bot.getContext(platform.id, { headless: true });
    const loggedIn = await bot.probeLogin(platform, ctx);
    res.json({ ok: true, loggedIn });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 定时跟进：每 2 分钟抓取一次「已发布且处于审核中/待发布」记录的最新状态
setInterval(async () => {
  try {
    const records = store.listRecords();
    const due = records.filter((r) =>
      r.platforms.some((p) => p.status === 'success' && ['auditing', 'scheduled'].includes(p.publishStatus))
    );
    if (!due.length) return;
    for (const r of due.slice(0, 3)) {
      try {
        await publisher.syncRecordStatus(r);
      } catch (e) {
        console.error('状态跟进失败：', e.message);
      }
    }
  } catch (e) {
    console.error('状态轮询异常：', e.message);
  }
}, 120 * 1000);

// 调试：检测发文页「发布」按钮是否存在、是否在视口内，并滚动到它
app.post('/api/debug/publishbtn/:id', async (req, res) => {
  const platform = publisher.getPlatform(req.params.id);
  if (!platform) return res.status(404).json({ error: '平台不存在' });
  try {
    const ctx = await browser.getContext(platform.id);
    const page = await ctx.newPage();
    await page.goto(platform.publishUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);
    const sels = platform.selectors?.publishBtn || [
      'button.omui-button--primary:has-text("发布")',
      '.publish-btn',
      'button:has-text("发布")',
    ];
    const data = await page.evaluate((sels) => {
      const out = { sels, found: [] };
      for (const s of sels) {
        let el = null;
        try { el = document.querySelector(s); } catch { continue; }
        if (!el) continue;
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        out.found.push({
          sel: s,
          text: (el.innerText || '').trim().slice(0, 20),
          visible: r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden',
          inViewport: r.top >= 0 && r.bottom <= window.innerHeight,
          rect: `${Math.round(r.width)}x${Math.round(r.height)}@(${Math.round(r.left)},${Math.round(r.top)})`,
          scrollY: Math.round(window.scrollY),
          docH: Math.round(document.body.scrollHeight),
        });
      }
      // 兜底 dump：页面里所有文本含「发布」的元素 + 底部固定条内的按钮
      const publishEls = [...document.querySelectorAll('button, a, [class*="publish"], [class*="Publish"], [role="button"], [class*="submit"], [class*="Send"]')]
        .filter((el) => (el.innerText || '').trim().includes('发布') || (el.getAttribute('aria-label') || '').includes('发布'))
        .map((el) => {
          const r = el.getBoundingClientRect();
          const st = getComputedStyle(el);
          return {
            tag: el.tagName.toLowerCase(),
            cls: (el.className || '').toString().trim().slice(0, 120),
            text: (el.innerText || '').trim().slice(0, 20),
            visible: r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden',
            fixed: st.position === 'fixed' || st.position === 'sticky',
            rect: `${Math.round(r.width)}x${Math.round(r.height)}@(${Math.round(r.left)},${Math.round(r.top)})`,
            parentCls: (el.parentElement?.className || '').toString().slice(0, 80),
          };
        });
      out.publishEls = publishEls.slice(0, 25);
      // 底部固定工具栏按钮（按钮通常固定在页面底部）
      const fixedBars = [...document.querySelectorAll('div, footer')]
        .filter((el) => { const st = getComputedStyle(el); return (st.position === 'fixed' || st.position === 'sticky') && (el.innerText || '').includes('发布'); })
        .map((el) => ({
          cls: (el.className || '').toString().slice(0, 120),
          text: (el.innerText || '').trim().slice(0, 120),
          btns: [...el.querySelectorAll('button, [role="button"]')].map((b) => ({ cls: (b.className || '').toString().slice(0, 100), text: (b.innerText || '').trim().slice(0, 20) })),
        }));
      out.fixedBars = fixedBars.slice(0, 5);
      window.scrollTo(0, document.body.scrollHeight);
      return out;
    }, sels);
    await page.waitForTimeout(800);
    const after = await page.evaluate((sels) => {
      const out = { afterScroll: [] };
      for (const s of sels) {
        let el = null;
        try { el = document.querySelector(s); } catch { continue; }
        if (!el) continue;
        const r = el.getBoundingClientRect();
        out.afterScroll.push({ sel: s, text: (el.innerText || '').trim().slice(0, 20), inViewportNow: r.top >= 0 && r.bottom <= window.innerHeight, rect: `${Math.round(r.width)}x${Math.round(r.height)}@(${Math.round(r.left)},${Math.round(r.top)})`, scrollY: Math.round(window.scrollY) });
      }
      return out;
    }, sels);
    data.afterScroll = after.afterScroll;
    await page.close().catch(() => {});
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- 发布状态跟进（探测内容管理页结构） ----------
app.post('/api/debug/status/:id', async (req, res) => {
  const platform = publisher.getPlatform(req.params.id);
  if (!platform) return res.status(404).json({ error: '平台不存在' });
  try {
    const ctx = await browser.getContext(platform.id);
    const page = await ctx.newPage();
    // 先打开平台主站，dump 侧边栏菜单链接，找到「内容管理」列表页
    await page.goto('https://om.qq.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000);
    const menus = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('a[href], [role="menuitem"], [class*="menu"] a, [class*="nav"] a').forEach((a) => {
        const text = (a.innerText || a.textContent || '').trim();
        const href = a.getAttribute('href') || '';
        if (text && href && /内容|文章|稿件|管理|发布|审核|数据/.test(text)) {
          out.push({ text: text.slice(0, 20), href });
        }
      });
      return out.slice(0, 60);
    });
    res.json({ url: page.url(), title: await page.title(), menus: menus.slice(0, 40) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- 发布状态跟进（抓取已发布文章列表状态） ----------
app.post('/api/debug/status-list/:id', async (req, res) => {
  const platform = publisher.getPlatform(req.params.id);
  if (!platform) return res.status(404).json({ error: '平台不存在' });
  try {
    const ctx = await browser.getContext(platform.id);
    const page = await ctx.newPage();
    await page.goto('https://om.qq.com/main/management/articleManage', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4500);
    const url = page.url();
    const data = await page.evaluate(() => {
      const cards = [];
      // 找到所有灰色状态文本元素（list__greyitem-*），向上定位到文章卡片
      const statusEls = [...document.querySelectorAll('[class*="greyitem"]')];
      for (const st of statusEls) {
        const statusText = (st.innerText || '').trim();
        if (!/^(已发布|审核中|待发布|未通过|草稿|审核失败|已下线|已下架)$/.test(statusText)) continue;
        // 向上找卡片容器
        let card = st;
        for (let i = 0; i < 8; i++) {
          card = card.parentElement;
          if (!card) break;
          if ((card.innerText || '').trim().length > 40) break;
        }
        if (!card) continue;
        const cardText = (card.innerText || '').trim();
        // 标题一般是卡片里第一个较长的链接/文本
        const titleEl = card.querySelector('a[href*="article"], [class*="title"], h3, h2, [class*="name"]') || card;
        const title = (titleEl.innerText || titleEl.textContent || '').trim().slice(0, 90);
        const timeMatch = cardText.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
        cards.push({
          status: statusText,
          title,
          time: timeMatch ? timeMatch[0] : '',
          cardCls: (card.className || '').toString().slice(0, 80),
          cardText: cardText.slice(0, 220),
        });
      }
      return { url: location.href, cardCount: cards.length, cards: cards.slice(0, 12) };
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n  PublishHub 已启动`);
  console.log(`  ➜ 打开 http://localhost:${PORT}\n`);
});
