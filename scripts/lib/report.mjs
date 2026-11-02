// 写 <out>/<date>/report.md 和 data.json
import fs from 'node:fs';
import path from 'node:path';

const SOURCE = { subtitle: '字幕', asr: '转写', text: '正文', 'text+asr': '正文+转写' };

const num = (n) => {
  if (n == null || Number.isNaN(+n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e8) return `${+(n / 1e8).toFixed(2)}亿`;
  if (a >= 1e4) return `${+(n / 1e4).toFixed(1)}万`;
  return String(n);
};
const short = (s, n = 60) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const cell = (s) => short(s, Infinity).replace(/\|/g, '\\|');
const linkText = (s) => cell(s).replace(/[[\]]/g, '\\$&') || '（无标题）';
const reason = (s, n) => (/^预算用完/.test(s) ? s : `失败：${cell(short(s, n))}`);
const byLikes = (x, y) => (y.metrics?.likes ?? -1) - (x.metrics?.likes ?? -1);

function boardLine(p) {
  const board = p.board ? ` ${p.board.period}（${p.board.date}）` : '';
  return `${p.label}${board}${p.status === 'ok' ? '' : `：${short(p.error, 40)}`}`;
}

function workCell(w) {
  const m = w.metrics ?? {};
  const stats = [`赞 ${num(m.likes)}`, m.plays != null && `播放 ${num(m.plays)}`].filter(Boolean).join(' / ');
  return `[${linkText(short(w.title || w.desc, 40))}](${w.url}) ${stats}`;
}

function copyCell(w) {
  if (w.copy?.chars === 0) return /asr/.test(w.copy.source) ? '未转出有效语音' : '正文为空';
  if (w.copy) return `[${SOURCE[w.copy.source] ?? w.copy.source} ${w.copy.chars}字](../${w.copy.file})`;
  return reason(w.copy_error, 40);
}

function platformSection(p) {
  const out = [`## ${p.label}${p.board ? ` · ${p.board.period} · ${p.board.date}` : ''}`, ''];
  if (p.board?.url) out.push(`榜单：${p.board.url}`, '');
  if (p.status !== 'ok' && !p.entries.length) {
    out.push(p.status === 'unavailable' ? p.error : reason(p.error, 200), '');
    return out;
  }
  if (p.error) out.push(reason(p.error, 200), '');
  out.push('| 排名 | 作者 | 涨粉 | 总粉 | 窗口作品数 | 代表作 | 文案 |', '|---|---|---|---|---|---|---|');
  const notes = [];
  for (const e of p.entries) {
    const who = e.creator?.url ? `[${linkText(e.creator.name || e.name)}](${e.creator.url})` : cell(e.name);
    const followers = num(e.creator?.followers ?? e.followers);
    if (e.error) {
      out.push(`| ${e.rank} | ${who} | +${num(e.gain)} | ${followers} | — | ${reason(e.error, 60)} | |`);
      continue;
    }
    const reps = e.works.filter((w) => w.representative).sort(byLikes);
    out.push(`| ${e.rank} | ${who} | +${num(e.gain)} | ${followers} | ${e.works.length} | ${reps.map(workCell).join('<br>') || '窗口内无作品'} | ${reps.map(copyCell).join('<br>')} |`);
    if (e.note) notes.push(`- ${e.rank} ${cell(e.name)}：${cell(e.note)}`);
  }
  out.push('');
  if (notes.length) out.push(...notes, '');
  return out;
}

export function writeReport(dir, data) {
  fs.mkdirSync(dir, { recursive: true });
  const lines = [`# 涨粉榜日报 ${data.date}`, '', data.platforms.map(boardLine).join(' ｜ ')];
  if (data.budget_exhausted) lines.push('', `整轮预算 ${data.opts.budget_min} 分钟用完，之后的作者或文案已跳过（见下表）。`);
  lines.push('');
  for (const p of data.platforms) lines.push(...platformSection(p));
  lines.push('## 观察', '', '');
  fs.writeFileSync(path.join(dir, 'report.md'), lines.join('\n'));

  // media 里是会过期的地址和请求头，不落盘
  const json = JSON.stringify(data, (k, v) => (k === 'media' ? undefined : v), 2);
  fs.writeFileSync(path.join(dir, 'data.json'), json + '\n');
  return path.join(dir, 'report.md');
}
