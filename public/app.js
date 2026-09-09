/* PublishHub 前端逻辑 */
const $ = (s) => document.querySelector(s);
const api = {
  async req(url, opts = {}) {
    const isForm = opts.body instanceof FormData;
    const headers = isForm ? {} : { 'Content-Type': 'application/json' };
    const r = await fetch(url, {
      ...opts,
      headers,
      // 表单上传不序列化 body；JSON 时序列化
      body: opts.body ? (isForm ? opts.body : JSON.stringify(opts.body)) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  },
};

// ---------- Tab 切换 ----------
document.querySelectorAll('.tab').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    $('#tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'records') loadRecords();
    if (btn.dataset.tab === 'overview') loadOverview();
    if (btn.dataset.tab === 'accounts') loadAccounts();
    if (btn.dataset.tab === 'library') loadArticles();
  };
});

// ---------- 稿件库 ----------
let articles = [];
async function loadArticles() {
  articles = await api.req('/api/articles');
  const box = $('#article-list');
  if (!articles.length) {
    box.innerHTML = '<div class="empty">还没有稿件，点击上方「上传稿件」开始</div>';
    return;
  }
  box.innerHTML = '';
  for (const a of articles) {
    const el = document.createElement('div');
    el.className = 'card';
    el.innerHTML = `
      ${a.coverPath ? `<img class="cover-thumb" style="width:100%;height:140px" src="/uploads/${encodeURIComponent(a.coverPath.split('/').pop())}" />` : ''}
      <div class="title">${esc(a.title)}</div>
      <div class="meta">来源：${esc(a.sourceFile || '-')} · ${new Date(a.createdAt).toLocaleString('zh-CN')}</div>
      <div class="actions">
        <button class="btn primary small" data-act="publish">发稿</button>
        <button class="btn small" data-act="preview">预览</button>
        <button class="btn small danger" data-act="del">删除</button>
      </div>`;
    el.querySelector('[data-act="publish"]').onclick = () => openPublishModal(a.id);
    el.querySelector('[data-act="preview"]').onclick = () => {
      const w = window.open('', '_blank');
      const full = articles.find((x) => x.id === a.id);
      w.document.write(`<title>${esc(a.title)}</title><body style="max-width:720px;margin:40px auto;font-family:-apple-system,'PingFang SC',sans-serif;line-height:1.8"><h1>${esc(a.title)}</h1>${full.html}</body>`);
    };
    el.querySelector('[data-act="del"]').onclick = async () => {
      if (!confirm(`删除稿件「${a.title}」？`)) return;
      await api.req('/api/articles/' + a.id, { method: 'DELETE' });
      loadArticles();
    };
    box.appendChild(el);
  }
}

$('#doc-file').onchange = async () => {
  const file = $('#doc-file').files[0];
  if (!file) return;
  $('#upload-hint').textContent = '解析中…';
  const fd = new FormData();
  fd.append('file', file);
  try {
    await api.req('/api/articles/upload', { method: 'POST', body: fd });
    $('#upload-hint').textContent = '✓ 解析成功';
    loadArticles();
  } catch (e) {
    $('#upload-hint').textContent = '✗ ' + e.message;
  }
  $('#doc-file').value = '';
  setTimeout(() => ($('#upload-hint').textContent = ''), 4000);
};

// ---------- 发布弹窗 ----------
let currentArticle = null;
let currentCoverPath = null;
let publishPlatforms = [];

// 根据勾选的平台动态渲染补充字段（分类/标签等）
function renderPlatformFields() {
  const box = $('#pub-extra');
  box.innerHTML = '';
  const checked = [...document.querySelectorAll('#pub-platforms input:checked')].map((i) => i.value);
  for (const pid of checked) {
    const platform = publishPlatforms.find((p) => p.id === pid);
    if (!platform || (!platform.extraFields?.length && !platform.coverMode)) continue;
    // 合并普通补充字段 + 封面形式（封面形式优先展示，如大鱼号）
    const fields = [];
    if (platform.coverMode) fields.push({ ...platform.coverMode, key: 'coverMode' });
    fields.push(...(platform.extraFields || []));
    for (const f of fields) {
      const div = document.createElement('div');
      div.className = 'ef';
      const ph = f.placeholder || f.label;
      const inputId = `extra-${pid}-${f.key}`;
      let inputHtml;
      if (f.type === 'tags') {
        // 标签：chip 输入器（#xxx + 空格 立起来成标签）
        inputHtml = `
          <div class="ef-tag-wrap" id="tagwrap-${pid}-${f.key}">
            <div class="chips" id="chips-${pid}-${f.key}"></div>
            <input type="text" class="tag-input" id="tag-input-${pid}-${f.key}" placeholder="${esc(ph)}" />
            <input type="hidden" data-pid="${pid}" data-key="${f.key}" id="extra-${pid}-${f.key}" />
          </div>`;
        // 渲染后挂载交互
        setTimeout(() => mountTagInput(pid, f.key), 0);
      } else if ((f.type === 'select' || f.type === 'radio' || f.type === 'inline-radio') && Array.isArray(f.options)) {
        const opts = f.options
          .map((o) => `<option value="${esc(o)}"${o === f.defaultValue ? ' selected' : ''}>${esc(o)}</option>`)
          .join('');
        const phOpt = f.defaultValue ? '' : `<option value="">${esc(f.placeholder || '请选择')}</option>`;
        inputHtml = `<select id="${inputId}" data-pid="${pid}" data-key="${f.key}" style="width:100%;padding:8px 12px;border:1px solid var(--line);border-radius:8px;font-size:14px;background:#fff">${phOpt}${opts}</select>`;
      } else if (f.type === 'textarea') {
        inputHtml = `<textarea id="${inputId}" data-pid="${pid}" data-key="${f.key}" rows="2" placeholder="${esc(ph)}" style="width:100%;padding:8px 12px;border:1px solid var(--line);border-radius:8px;font-size:14px;font-family:inherit;resize:vertical"></textarea>`;
      } else {
        inputHtml = `<input type="text" id="${inputId}" data-pid="${pid}" data-key="${f.key}" placeholder="${esc(ph)}" />`;
      }
      const tip =
        f.type === 'tags'
          ? '<div class="ef-tip">输入 <code>#标签</code> 后按空格（或回车）变成标签，按退格可删除最后一个</div>'
          : f.type === 'select'
          ? '<div class="ef-tip">从下拉建议中选择，或手动输入</div>'
          : f.type === 'radio'
          ? '<div class="ef-tip">点发布时会自动帮你点「添加内容自主声明」→ 选中该项 → 点「确认」</div>'
          : f.type === 'inline-radio'
          ? '<div class="ef-tip">点发布会自动在发文页勾选对应选项</div>'
          : '';
      div.innerHTML = `<div class="ef-label">${esc(platform.name)} · ${esc(f.label)}</div>${inputHtml}${tip}`;
      box.appendChild(div);
    }
  }
}

// 标签 chip 输入：#xxx + 空格 → 变成 chip 提交
function mountTagInput(pid, key) {
  const wrap = document.getElementById(`tagwrap-${pid}-${key}`);
  if (!wrap || wrap.dataset.mounted) return;
  wrap.dataset.mounted = '1';
  const chipsEl = wrap.querySelector('.chips');
  const input = wrap.querySelector('.tag-input');
  const hidden = wrap.querySelector('input[type="hidden"]');
  const tags = [];

  function sync() {
    hidden.value = tags.join(' ');
  }
  function render() {
    chipsEl.innerHTML = tags
      .map(
        (t, i) =>
          `<span class="tag-chip">#${esc(t)}<button type="button" data-i="${i}" title="移除">×</button></span>`
      )
      .join('');
    chipsEl.querySelectorAll('button').forEach((btn) => {
      btn.onclick = () => {
        tags.splice(+btn.dataset.i, 1);
        render();
        sync();
      };
    });
    sync();
  }
  function commit() {
    const v = input.value;
    if (!v) return;
    const parts = v
      .split(/[\s,，、]+/)
      .map((s) => s.replace(/^#+/, '').trim())
      .filter(Boolean);
    for (const p of parts) tags.push(p);
    input.value = '';
    render();
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter' || e.key === ',') {
      if (input.value) {
        e.preventDefault();
        commit();
      }
    } else if (e.key === 'Backspace' && !input.value && tags.length) {
      tags.pop();
      render();
    }
  });
  // 输入框失焦也提交残留文字
  input.addEventListener('blur', () => {
    if (input.value) commit();
  });
  // 粘贴支持：直接把整段按空格/逗号拆开
  input.addEventListener('paste', (e) => {
    setTimeout(() => commit(), 0);
  });
}
async function openPublishModal(articleId) {
  try {
    currentArticle = await api.req('/api/articles/' + articleId);
    currentCoverPath = currentArticle.coverPath;
    $('#pub-article-title').textContent = currentArticle.title;
    $('#pub-title').value = currentArticle.title;
    const cover = $('#pub-cover');
    if (currentCoverPath) {
      cover.src = '/uploads/' + encodeURIComponent(currentCoverPath.split('/').pop());
      cover.hidden = false;
    } else cover.hidden = true;
    $('#pub-status').hidden = true;
    $('#pub-status').innerHTML = '';

    const platforms = await api.req('/api/platforms');
    publishPlatforms = platforms;
    const box = $('#pub-platforms');
    box.innerHTML = '';
    for (const p of platforms) {
      const lab = document.createElement('label');
      lab.innerHTML = `<input type="checkbox" value="${p.id}" /> ${p.name}`;
      lab.querySelector('input').addEventListener('change', renderPlatformFields);
      box.appendChild(lab);
    }
    renderPlatformFields();
    $('#publish-modal').classList.add('show');
  } catch (e) {
    alert('打开发稿弹窗失败：' + e.message);
  }
}

$('#modal-close').onclick = $('#modal-cancel').onclick = () => {
  $('#publish-modal').classList.remove('show');
};

$('#cover-file').onchange = async () => {
  const file = $('#cover-file').files[0];
  if (!file || !currentArticle) return;
  const fd = new FormData();
  fd.append('file', file);
  const r = await api.req(`/api/articles/${currentArticle.id}/cover`, { method: 'POST', body: fd });
  currentCoverPath = r.coverPath;
  const cover = $('#pub-cover');
  cover.src = URL.createObjectURL(file);
  cover.hidden = false;
  $('#cover-file').value = '';
};

$('#pub-submit').onclick = async () => {
  const title = $('#pub-title').value.trim();
  const platformIds = [...document.querySelectorAll('#pub-platforms input:checked')].map((i) => i.value);
  const mode = document.querySelector('input[name="mode"]:checked').value;
  const status = $('#pub-status');

  if (!platformIds.length) return alert('请选择至少一个平台');
  // 收集各平台补充字段（input/textarea/select）
  const extra = {};
  for (const el of document.querySelectorAll('#pub-extra input, #pub-extra textarea, #pub-extra select')) {
    if (!el.value || !el.value.trim()) continue;
    if (!extra[el.dataset.pid]) extra[el.dataset.pid] = {};
    extra[el.dataset.pid][el.dataset.key] = el.value.trim();
  }
  const btn = $('#pub-submit');
  btn.disabled = true;
  status.hidden = false;
  status.innerHTML = '<div class="log-line">正在保存修改并发起发布…</div>';

  try {
    await api.req('/api/articles/' + currentArticle.id, {
      method: 'PUT',
      body: { title },
    });
    const record = await api.req('/api/publish', {
      method: 'POST',
      body: { articleId: currentArticle.id, platforms: platformIds, mode, extra },
    });
    pollRecord(record.id, status);
  } catch (e) {
    status.innerHTML = `<div style="color:var(--err)">✗ ${esc(e.message)}</div>`;
    btn.disabled = false;
  }
};

function pollRecord(recordId, statusEl) {
  const timer = setInterval(async () => {
    const rec = await api.req('/api/records/' + recordId);
    statusEl.innerHTML = rec.platforms
      .map((p) => {
        const last = p.logs[p.logs.length - 1];
        return `<div><b>${p.name}</b>：${statusBadge(p.status)} ${esc(last ? last.msg : '')}</div>`;
      })
      .join('');
    const done = rec.platforms.every((p) => ['success', 'failed', 'confirm'].includes(p.status));
    if (done) {
      clearInterval(timer);
      $('#pub-submit').disabled = false;
      statusEl.insertAdjacentHTML(
        'beforeend',
        `<div class="log-line" style="margin-top:6px">任务结束。详见「发布记录」，confirm 状态表示已停在发文页等待人工确认。</div>`
      );
    }
  }, 2000);
}

function statusBadge(s) {
  const map = {
    pending: ['pending', '排队中'],
    running: ['running', '执行中'],
    success: ['ok', '成功'],
    failed: ['err', '失败'],
    confirm: ['warn', '待人工确认'],
  };
  const [cls, text] = map[s] || ['pending', s];
  return `<span class="badge ${cls}">${text}</span>`;
}

// 平台侧审核状态徽章（发布成功后自动跟进）
function publishStatusBadge(p) {
  if (!p.publishStatus) return '';
  const map = {
    auditing: ['warn', '审核中'],
    published: ['ok', '审核通过'],
    scheduled: ['pending', '待发布'],
    rejected: ['err', '审核未通过'],
    offline: ['pending', '已下线'],
    draft: ['pending', '草稿'],
  };
  const [cls, text] = map[p.publishStatus] || ['pending', p.publishStatus];
  const t = p.publishStatusAt
    ? `<small style="opacity:.6;margin-left:3px;font-size:11px">${new Date(p.publishStatusAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</small>`
    : '';
  return `<span class="badge ${cls}">${text}${t}</span>`;
}

// ---------- 账号管理 ----------
// 拉取机器人健康度并更新 UI（一个机器人 = 一个 headless chromium，发稿和抓状态共用）
async function loadBot(platformId) {
  const all = await api.req('/api/bot/status');
  const info = all[platformId];
  const sb = document.querySelector(`.bot-status-${platformId}`);
  if (!sb || !info) return;
  if (info.needsLogin) sb.textContent = '⚠ 未登录（请「扫码登录」）';
  else sb.textContent = '🤖 已就绪（自动发稿 + 自动跟进状态，全程不弹你的屏幕）';
}

// ---------- 账号管理 ----------
async function loadAccounts() {
  const platforms = await api.req('/api/platforms');
  const box = $('#account-list');
  box.innerHTML = '';
  for (const p of platforms) {
    const el = document.createElement('div');
    el.className = 'card';
    el.innerHTML = `
      <div class="title">${p.name} <span class="meta">${p.site}</span></div>
      <div class="meta">发文页：${p.publishUrl ? esc(p.publishUrl) : '<span style="color:var(--err)">未配置</span>'}</div>
      <div class="field" style="margin:6px 0">
        <input type="text" class="puburl-input" value="${esc(p.publishUrl || '')}" placeholder="发文页地址（打开该平台发文页，复制地址栏 URL）" style="width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:8px;font-size:13px" />
      </div>
      <div class="actions">
        <button class="btn small" data-act="save">保存发文页地址</button>
      </div>
      <div class="botbox" id="botbox-${p.id}" style="margin-top:8px;padding:8px 10px;background:#f7f8fb;border-radius:8px;font-size:12px;color:#666">
        <span class="meta">🤖 机器人：</span><span class="bot-status-${p.id}">检测中…</span>
        <span style="margin-left:8px">
          <button class="btn small" data-act="bot-login" title="首次扫码登录（一次性，登录态会保存到独立 profile，后续 headless 运行不再弹窗）">扫码登录</button>
          <button class="btn small" data-act="bot-probe-login" title="测试登录态：headless 打开发文页看是否被踢到登录页（不弹任何窗口）">测登录</button>
          <button class="btn small" data-act="bot-probe-status" title="测试状态抓取：headless 抓一期内容管理页（不弹任何窗口）">测抓取</button>
        </span>
      </div>`;
    el.querySelector('[data-act="bot-login"]').onclick = async () => {
      const sb = el.querySelector(`.bot-status-${p.id}`);
      sb.textContent = '已请求弹出扫码窗口…';
      const r = await api.req(`/api/bot/login/${p.id}`, { method: 'POST' });
      sb.textContent = r.loggedIn ? '已登录' : (r.timeout ? '等待扫码超时' : (r.closed ? '用户关闭了窗口' : '未登录'));
      loadBot(p.id);
    };
    el.querySelector('[data-act="bot-probe-login"]').onclick = async () => {
      const sb = el.querySelector(`.bot-status-${p.id}`);
      sb.textContent = '测登录中…';
      const r = await api.req(`/api/bot/probe-login/${p.id}`, { method: 'POST' });
      if (r.ok && r.loggedIn) sb.textContent = '✅ 已登录，可以自动发布';
      else if (r.ok && !r.loggedIn) sb.textContent = '❌ 未登录，请先「扫码登录」';
      else sb.textContent = `❌ 异常：${r.error || '未知'}`;
    };
    el.querySelector('[data-act="bot-probe-status"]').onclick = async () => {
      const sb = el.querySelector(`.bot-status-${p.id}`);
      sb.textContent = '抓取中…';
      const r = await api.req(`/api/bot/probe-status/${p.id}`, { method: 'POST' });
      if (r.ok) sb.textContent = `🤖 抓取成功，本期共 ${r.items.length} 条`;
      else sb.textContent = `抓取失败：${r.reason || '未知'}`;
    };
    // 主动查询一次该平台机器人的健康
    loadBot(p.id);
    el.querySelector('[data-act="save"]').onclick = async () => {
      const val = el.querySelector('.puburl-input').value.trim();
      await api.req('/api/platforms/' + p.id, { method: 'PUT', body: { publishUrl: val } });
      alert('已保存');
      loadAccounts();
    };
    box.appendChild(el);
  }
}

// ---------- 发布记录 ----------
async function loadRecords() {
  const records = await api.req('/api/records');
  const box = $('#record-list');
  if (!records.length) {
    box.innerHTML = '<div class="empty">暂无发布记录</div>';
    return;
  }
  box.innerHTML = '';
  for (const r of records) {
    const el = document.createElement('div');
    el.className = 'record';
    el.innerHTML = `
      <div class="head">
        <span class="t">${esc(r.articleTitle)}</span>
        <span class="time">${new Date(r.createdAt).toLocaleString('zh-CN')} · ${r.mode === 'auto' ? '全自动' : '预填+人工确认'}</span>
      </div>
      ${r.platforms
        .map(
          (p) => `
        <div class="plat-item">
          <span class="name">${p.name}</span>
          ${statusBadge(p.status)}
          ${publishStatusBadge(p)}
          <span class="msg">${esc(p.error || (p.logs[p.logs.length - 1] || {}).msg || '')}</span>
          ${p.status === 'success' ? `<button class="btn small refresh-status" data-rid="${esc(r.id)}" data-pid="${esc(p.platform)}">刷新状态</button>` : ''}
        </div>
        <details class="logs"><summary>日志</summary><pre>${p.logs.map((l) => `[${l.t}] ${l.msg}`).join('\n') || '无'}</pre></details>`
        )
        .join('')}`;
    // 绑定「刷新状态」按钮
    el.querySelectorAll('.refresh-status').forEach((btn) => {
      btn.onclick = async () => {
        const rid = btn.dataset.rid;
        const pid = btn.dataset.pid;
        btn.disabled = true;
        btn.textContent = '刷新中…';
        try {
          await api.req(`/api/records/${rid}/status`, { method: 'POST' });
        } catch (e) {
          alert('刷新失败：' + e.message);
        }
        loadRecords();
      };
    });
    box.appendChild(el);
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- 发布总览表格 ----------
// 顶部统计卡片 + 表格：媒体 / 稿件标题 / 日期 / 发布时间 / 发布状态 / 媒体链接 / 操作
const PLATFORM_ICON = { qq: '🐧', netease: '🎵', sohu: '🦊', toutiao: '抖音', dayu: '🐟' };

async function loadOverview() {
  const records = await api.req('/api/records');
  const box = $('#overview-table');
  if (!records.length) {
    box.innerHTML = `
      <div class="ov-empty">
        <div class="ov-empty-ico">📭</div>
        <div class="ov-empty-t">暂无发布数据</div>
        <div class="ov-empty-s">先去「稿件库」发一篇试试</div>
      </div>`;
    return;
  }
  // 扁平化：最新在最上；只保留「执行中 / 成功 / 失败」三类
  const KEEP_STATUS = new Set(['running', 'success', 'failed']);
  const rows = [];
  for (const r of [...records].reverse()) {
    const d = new Date(r.createdAt);
    const date = d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
    const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    for (const p of r.platforms) {
      if (!KEEP_STATUS.has(p.status)) continue;
      rows.push({ media: p.name, title: r.articleTitle, date, time, p, recordId: r.id, createdAt: r.createdAt });
    }
  }
  // 统计卡片
  const published = rows.filter((r) => r.p.publishStatus === 'published').length;
  const auditing = rows.filter((r) => r.p.publishStatus === 'auditing').length;
  const failed = rows.filter((r) => r.p.status === 'failed' || r.p.publishStatus === 'rejected').length;
  const stats = [
    { label: '发布记录', num: rows.length, cls: '' },
    { label: '审核通过', num: published, cls: 'ok' },
    { label: '审核中', num: auditing, cls: 'warn' },
    { label: '失败 / 未通过', num: failed, cls: 'err' },
  ];
  box.innerHTML = `
    <div class="ov-stats">
      ${stats.map((s) => `<div class="ov-stat ${s.cls}"><div class="num">${s.num}</div><div class="lbl">${s.label}</div></div>`).join('')}
    </div>
    <div class="ov-wrap">
    <table class="ov-table">
      <thead>
        <tr>
          <th>媒体</th>
          <th>稿件标题</th>
          <th>日期 · 时间</th>
          <th>发布状态</th>
          <th>媒体链接</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((row, i) => `
          <tr>
            <td><span class="ov-media"><span class="ov-avatar">${esc(PLATFORM_ICON[row.p.platform] || '📢')}</span>${esc(row.media)}</span></td>
            <td class="ov-title" title="${esc(row.title)}">${esc(row.title)}</td>
            <td class="ov-dt">${row.date}<br><span class="ov-dt-time">${row.time}</span></td>
            <td><span class="ov-badges">${statusBadge(row.p.status)} ${publishStatusBadge(row.p)}</span></td>
            <td>${row.p.mediaUrl
              ? `<a class="ov-link" href="${esc(row.p.mediaUrl)}" target="_blank" rel="noopener" title="${esc(row.p.mediaUrl)}"><span class="ov-link-txt">${esc(row.p.mediaUrl)}</span></a>`
              : '<span class="ov-pending">待回填</span>'}</td>
            <td class="ov-ops">
              <button class="btn xs ov-edit" data-act="edit" data-idx="${i}" title="编辑此行">✏️</button>
              <button class="btn xs danger ov-del" data-act="del" data-idx="${i}" title="删除此平台行（不影响平台上已发布的文章）">🗑</button>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>
    </div>
    <div class="hint" style="margin-top:10px">共 ${rows.length} 条发布记录 · ${records.length} 篇稿件 · 媒体链接在稿件审核通过后由机器人自动回填</div>`;
  bindOverviewActions(box, rows);
}

// 表格内编辑/删除按钮
function bindOverviewActions(box, rows) {
  box.onclick = async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const row = rows[+btn.dataset.idx];
    if (!row) return;
    if (btn.dataset.act === 'edit') openOvEditModal(row);
    if (btn.dataset.act === 'del') {
      if (!confirm(`删除「${row.title}」在 ${row.media} 的这条发布记录？（只删本系统记录，不影响平台上已发布的文章）`)) return;
      btn.disabled = true;
      try {
        await api.req(`/api/records/${row.recordId}/${row.p.platform}`, { method: 'DELETE' });
      } catch (err) {
        alert('删除失败：' + err.message);
        btn.disabled = false;
        return;
      }
      loadOverview();
    }
  };
}

// ---------- 总览行编辑弹窗 ----------
let ovEditRow = null;
function openOvEditModal(row) {
  ovEditRow = row;
  $('#ov-edit-media').textContent = row.media;
  $('#ov-edit-title').value = row.title;
  const d = new Date(row.createdAt);
  const pad = (n) => String(n).padStart(2, '0');
  $('#ov-edit-date').value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  $('#ov-edit-time').value = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  $('#ov-edit-publish-status').value = row.p.publishStatus || '';
  $('#ov-edit-url').value = row.p.mediaUrl || '';
  $('#ov-edit-modal').classList.add('show');
}

function closeOvEditModal() {
  $('#ov-edit-modal').classList.remove('show');
  ovEditRow = null;
}

$('#ov-edit-close').onclick = $('#ov-edit-cancel').onclick = closeOvEditModal;

$('#ov-edit-save').onclick = async () => {
  if (!ovEditRow) return;
  const row = ovEditRow;
  const btn = $('#ov-edit-save');
  btn.disabled = true;
  const title = $('#ov-edit-title').value.trim();
  const date = $('#ov-edit-date').value;
  const time = $('#ov-edit-time').value || '00:00';
  const url = $('#ov-edit-url').value.trim();
  const publishStatus = $('#ov-edit-publish-status').value;
  try {
    if (!title) throw new Error('标题不能为空');
    // 记录级：标题 + 日期时间（同一稿件所有平台行共享）
    await api.req('/api/records/' + row.recordId, {
      method: 'PUT',
      body: { articleTitle: title, createdAt: date ? new Date(`${date}T${time}`).toISOString() : undefined },
    });
    // 行级：媒体链接 + 平台侧状态
    await api.req(`/api/records/${row.recordId}/${row.p.platform}`, {
      method: 'PUT',
      body: { mediaUrl: url, publishStatus },
    });
    closeOvEditModal();
    loadOverview();
  } catch (e) {
    alert('保存失败：' + e.message);
  }
  btn.disabled = false;
};

// ---------- 初始化 ----------
loadArticles();
// 有进行中的任务时自动刷新记录
setInterval(() => {
  // 编辑弹窗开着时不自动刷新，避免误触
  if ($('#ov-edit-modal').classList.contains('show')) return;
  if ($('#tab-records').classList.contains('active')) loadRecords();
  if ($('#tab-overview').classList.contains('active')) loadOverview();
}, 5000);
