// Minimal, safe Markdown renderer for the AI's notes (escapes all HTML first).

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

export function renderMarkdown(src) {
  const lines = escapeHtml(src).split('\n');
  const out = [];
  let list = null; // 'ul' | 'ol'
  let para = [];
  let code = null;

  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (code !== null) {
      if (line.trim().startsWith('```')) { out.push(`<pre><code>${code.join('\n')}</code></pre>`); code = null; }
      else code.push(raw);
      continue;
    }
    if (line.trim().startsWith('```')) { flushPara(); closeList(); code = []; continue; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flushPara(); closeList(); const lvl = Math.min(4, h[1].length + 1); out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`); continue; }
    const task = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/);
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (task || ul || ol) {
      flushPara();
      const kind = ol && !ul ? 'ol' : 'ul';
      if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
      if (task) out.push(`<li class="task"><label><input type="checkbox"${task[1] !== ' ' ? ' checked' : ''}> ${inline(task[2])}</label></li>`);
      else out.push(`<li>${inline((ul || ol)[1])}</li>`);
      continue;
    }
    if (!line.trim()) { flushPara(); closeList(); continue; }
    if (list && /^\s{2,}/.test(raw)) { out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, ` ${inline(line.trim())}</li>`); continue; }
    closeList();
    para.push(line.trim());
  }
  if (code !== null) out.push(`<pre><code>${code.join('\n')}</code></pre>`);
  flushPara();
  closeList();
  return out.join('\n');
}

// Pulls ```splice [...]``` blocks out of the AI text. Returns { text, samples, pending }.
export function extractSpliceBlocks(text) {
  const samples = [];
  let cleaned = text.replace(/```splice\s*([\s\S]*?)```/g, (_, body) => {
    try {
      const arr = JSON.parse(body.trim());
      if (Array.isArray(arr)) samples.push(...arr.filter((s) => s && typeof s.query === 'string'));
    } catch { /* malformed block — drop it */ }
    return '';
  });
  // While streaming, hide a block that has opened but not closed yet.
  const open = cleaned.indexOf('```splice');
  const pending = open >= 0;
  if (pending) cleaned = cleaned.slice(0, open);
  return { text: cleaned, samples, pending };
}
