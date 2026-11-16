// 写 <out>/<date>/report.md 和 data.json
import fs from 'node:fs';
import path from 'node:path';
import { itemLine } from '../curate.mjs';

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
const peakFirst = (x, y) => (y.pick === 'peak') - (x.pick === 'peak') || byLikes(x, y);

// +20.2万（58%）· 峰值 10-19；比例按榜单给的总粉算
function gainCell(e) {
  const base = e.followers ?? e.creator?.followers;
  const ratio = e.gain != null && base ? `（${+((e.gain / base) * 100).toPrecision(2)}%）` : '';
  return `+${num(e.gain)}${ratio}${e.peak ? ` · 峰值 ${e.peak.date.slice(5)}` : ''}`;
}

const streak = (e, shown) => (!shown ? '' : e.streak > 1 ? `<br>连续 ${e.streak} 天` : '<br>新进');

function boardLine(p) {
  const board = p.board ? ` ${p.board.period}（${p.board.date}）` : '';
  return `${p.label}${board}${p.status === 'ok' ? '' : `：${short(p.error, 40)}`}`;
}

// 专精里的小节用「平台 · 分类」作标题，全站榜照旧只写平台
const title = (p, level) => `${'#'.repeat(level)} ${p.label}${p.focus ? ` · ${p.category}` : ''}${p.board ? ` · ${p.board.period} · ${p.board.date}` : ''}`;

function workCell(w) {
  const m = w.metrics ?? {};
  const stats = [`赞 ${num(m.likes)}`, m.plays != null && `播放 ${num(m.plays)}`].filter(Boolean).join(' / ');
  return `${w.pick === 'peak' ? '〔峰值〕' : ''}[${linkText(short(w.title || w.desc, 40))}](${w.url}) ${stats}`;
}

function copyCell(w) {
  if (w.copy?.chars === 0) return /asr/.test(w.copy.source) ? '未转出有效语音' : '正文为空';
  if (w.copy) return `[${SOURCE[w.copy.source] ?? w.copy.source} ${w.copy.chars}字](../${w.copy.file})`;
  return reason(w.copy_error, 40);
}

function platformSection(p, shown, level = 2) {
  const out = [title(p, level), ''];
  if (p.board?.url) out.push(`榜单：${p.board.url}${p.board.unchanged ? `（榜单未更新，同 ${p.board.date.slice(5)} 期）` : ''}`, '');
  if (p.status !== 'ok' && !p.entries.length) {
    out.push(p.status === 'unavailable' ? p.error : reason(p.error, 200), '');
    return out;
  }
  if (p.error) out.push(reason(p.error, 200), '');
  // 3 位及以上作者失败原因相同（如没登录），在表头前说一次，各行不再重复
  const count = {};
  for (const e of p.entries) if (e.error) count[e.error] = (count[e.error] ?? 0) + 1;
  const shared = new Set(Object.keys(count).filter((k) => count[k] >= 3));
  for (const k of shared) out.push(`作品未采集：${cell(short(k, 200))}`, '');
  out.push('| 排名 | 作者 | 涨粉 | 总粉 | 窗口作品数 | 代表作 | 文案 |', '|---|---|---|---|---|---|---|');
  const notes = [];
  for (const e of p.entries) {
    const who = (e.creator?.url ? `[${linkText(e.creator.name || e.name)}](${e.creator.url})` : cell(e.name)) + streak(e, shown);
    const followers = num(e.creator?.followers ?? e.followers);
    if (e.same_as) {
      out.push(`| ${e.rank} | ${who} | ${gainCell(e)} | ${followers} | ${e.works?.length ?? '—'} | 同${cell(e.same_as)}，不重复列 | |`);
      continue;
    }
    if (e.error) {
      out.push(`| ${e.rank} | ${who} | ${gainCell(e)} | ${followers} | — | ${shared.has(e.error) ? '—' : reason(e.error, 60)} | |`);
      continue;
    }
    const reps = e.works.filter((w) => w.representative).sort(peakFirst);
    out.push(`| ${e.rank} | ${who} | ${gainCell(e)} | ${followers} | ${e.works.length} | ${reps.map(workCell).join('<br>') || '窗口内无作品'} | ${reps.map(copyCell).join('<br>')} |`);
    if (e.note) notes.push(`- ${e.rank} ${cell(e.name)}：${cell(e.note)}`);
  }
  out.push('');
  if (notes.length) out.push(...notes, '');
  return out;
}

// 专精的关注账号：平台、作者、总粉、窗口作品数、代表作、文案
function accountSection(accounts) {
  const out = ['### 关注账号', '', '| 平台 | 作者 | 总粉 | 窗口作品数 | 代表作 | 文案 |', '|---|---|---|---|---|---|'];
  for (const x of accounts) {
    const name = x.creator?.name || x.input?.name || '（未命名）';
    const who = x.creator?.url || x.input?.url ? `[${linkText(name)}](${x.creator?.url || x.input.url})` : cell(name);
    const head = `| ${cell(x.label)} | ${who} | ${num(x.creator?.followers)} |`;
    if (x.skipped) out.push(`${head} — | 未采集：${cell(x.skipped)} | |`);
    else if (x.same_as) out.push(`${head} ${x.works?.length ?? '—'} | 同${cell(x.same_as)}，不重复列 | |`);
    else if (x.error) out.push(`${head} — | ${reason(x.error, 60)} | |`);
    else {
      const reps = x.works.filter((w) => w.representative).sort(peakFirst);
      out.push(`${head} ${x.works.length} | ${reps.map(workCell).join('<br>') || '窗口内无作品'} | ${reps.map(copyCell).join('<br>')} |`);
    }
  }
  out.push('');
  const notes = accounts.filter((x) => x.note && !x.same_as).map((x) => `- ${cell(x.creator?.name || x.input?.name)}：${cell(x.note)}`);
  if (notes.length) out.push(...notes, '');
  return out;
}

// data.json 先写（精选要读它），report.md 等精选算完再写
export function writeData(dir, data) {
  fs.mkdirSync(dir, { recursive: true });
  // media 里是会过期的地址和请求头，不落盘
  const json = JSON.stringify(data, (k, v) => (k === 'media' ? undefined : v), 2);
  fs.writeFileSync(path.join(dir, 'data.json'), json + '\n');
}

export function writeReport(dir, data, picks = []) {
  fs.mkdirSync(dir, { recursive: true });
  const site = data.platforms.filter((p) => !p.focus);
  const lines = [`# 涨粉榜日报 ${data.date}`, ''];
  if (site.length) lines.push(site.map(boardLine).join(' ｜ '), '');
  if (data.focus?.length) lines.push(`专精：${data.focus.map((f) => f.name).join('、')}${site.length ? '' : '（本次没跑全站榜）'}`, '');
  lines.pop();
  if (data.budget_exhausted) lines.push('', `整轮预算 ${data.opts.budget_min} 分钟用完，之后的作者或文案已跳过（见下表）。`);
  lines.push('');
  // 有前一天的日报才标「新进 / 连续 N 天」
  for (const p of site) lines.push(...platformSection(p, !!data.prev_date));
  for (const f of data.focus ?? []) {
    lines.push(`## 专精 · ${f.name}`, '');
    const all = data.platforms.filter((p) => p.focus === f.name);
    const off = all.filter((p) => p.status === 'skipped' && / 不在 --platforms 里$/.test(p.error ?? ''));
    const boards = all.filter((p) => !off.includes(p));
    if (f.error) lines.push(f.error, '');
    else if (!all.length && !f.accounts.length) lines.push('这个专精文件里没有分类榜，也没有关注账号', '');
    if (off.length) lines.push(`本次没跑（平台不在 --platforms 里）：${off.map((p) => `${p.name}:${p.category}`).join('、')}`, '');
    if (f.pack) lines.push(`竞对数据包：[${path.basename(f.pack)}](${path.basename(f.pack)})`, '');
    for (const p of boards) lines.push(...platformSection(p, !!data.prev_date, 3));
    if (f.accounts.length) lines.push(...accountSection(f.accounts));
  }
  lines.push(`## 今日精选（${picks.length} 条）`, '');
  if (data.curate_error) lines.push(`精选没算出来：${data.curate_error}`, '');
  else if (!picks.length) lines.push('今天没有新入选的作品（门槛和历史精选见 [精选库](../精选库.md)）。', '');
  else lines.push(...picks.map((x, i) => `${i + 1}. ${itemLine(x, '../')}`), '', '全部历史精选见 [精选库](../精选库.md)。', '');
  lines.push('## 观察', '', '');
  fs.writeFileSync(path.join(dir, 'report.md'), lines.join('\n'));
  return path.join(dir, 'report.md');
}
