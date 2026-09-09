/**
 * 文档解析：docx / markdown / txt / html -> { title, html }
 * - docx: mammoth 转 HTML，内嵌图片自动转 base64（便于富文本编辑器粘贴时上传）
 * - md:   marked 渲染
 * - txt:  按空行分段，第一行作标题
 */
const fs = require('fs');
const path = require('path');
const mammoth = require('mammoth');
const { marked } = require('marked');

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTitleFromHtml(html) {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) return stripTags(h1[1]).slice(0, 64);
  const h2 = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
  if (h2) return stripTags(h2[1]).slice(0, 64);
  const text = stripTags(html);
  return text.slice(0, 30) || '未命名稿件';
}

/** 把第一个 h1/h2 从正文中移除（标题已单独提取） */
function removeFirstHeading(html) {
  return html.replace(/<h[12][^>]*>[\s\S]*?<\/h[12]>/i, '');
}

async function parseDocx(filePath) {
  const { value: html } = await mammoth.convertToHtml(
    { path: filePath },
    {
      // 默认行为即内联 base64 图片，这里显式声明
      convertImage: mammoth.images.imgElement((image) => image.readAsBase64String()),
    }
  );
  return { html, title: extractTitleFromHtml(html) };
}

function parseMarkdown(text) {
  const html = marked.parse(text);
  return { html, title: extractTitleFromHtml(html) };
}

function parseText(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const title = (lines[0] || '未命名稿件').trim().slice(0, 64);
  const body = lines
    .slice(1)
    .map((l) => `<p>${l.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</p>`)
    .join('\n');
  return { html: body, title };
}

function parseHtml(text) {
  const html = text;
  return { html, title: extractTitleFromHtml(html) };
}

/**
 * @param {string} filePath 上传的原始文件路径
 * @returns {Promise<{title:string, html:string, ext:string}>}
 */
async function parseDocument(filePath) {
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  if (ext === 'docx') {
    const r = await parseDocx(filePath);
    return { ...r, ext };
  }
  const text = fs.readFileSync(filePath, 'utf-8');
  if (ext === 'md' || ext === 'markdown') {
    const r = parseMarkdown(text);
    return { ...r, ext };
  }
  if (ext === 'html' || ext === 'htm') {
    const r = parseHtml(text);
    return { ...r, ext };
  }
  if (ext === 'txt') {
    const r = parseText(text);
    return { ...r, ext };
  }
  throw new Error(`暂不支持的格式：.${ext}（支持 docx / md / html / txt）`);
}

/** 提取正文中第一张图片（base64 或链接），用于默认封面判断 */
function firstImageOf(html) {
  const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

module.exports = { parseDocument, extractTitleFromHtml, removeFirstHeading, firstImageOf };
