#!/usr/bin/env node
// 精选：从 <out>/*/data.json 全部日报和 <out>/copy/ 文案里挑出文案扎实的代表作，跨天按作品去重，
// 全量重建 <out>/精选库.jsonl 和 <out>/精选库.md。阈值改了重跑即可；run.mjs 跑完也会调用一次。
// 上榜本身就是入选理由：过门槛（时长 / 字数 / 非机构号 / 非敏感 / 有有效文案）的代表作都收，
// 〔峰值〕、爆款系数、涨粉前几只作标签和排序依据，每天每平台每专精留前几条；专精关注账号的代表作标〔关注〕，排在同专精榜单作者之后。
// 旧 data.json 里的 vertical（领域）当作专精名读。
// <out>/精选排除.txt：人工排除名单，每行一个作品 ID 或「平台:作者ID」，# 开头是注释。
// node scripts/curate.mjs --out <dir> [--min-video-sec 60] [--min-speech 300] [--min-note 150] [--min-tweet 140]
//                         [--burst 3] [--top-rank 3] [--max-per-day 4]
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

// 门槛默认值按 2026-11-02 至 11-14 九天日报校准
export const DEFAULTS = {
  minVideoSec: 60, // 视频时长下限（秒）；时长未知的不因此排除，但排在后面
  minSpeech: 300, // 视频口播 / 字幕有效字数（汉字按字、外文按词）
  minNote: 150, // 图文笔记正文有效字数（不计话题标签）
  minTweet: 140, // 纯文字推文有效字数
  burst: 3, // 爆款系数达到多少打「爆款」标签
  topRank: 3, // 涨粉排名前几打「涨粉前几」标签
  maxPerDay: 4, // 同一天、同一平台、同一专精最多留几条
};

const HOT = '\n## 热评\n';
const TRUNC = /\n?（只转写了前 \d+ 分钟，全长约 (\d+) 分钟）/;
const CJK = '\\p{sc=Han}\\p{sc=Hiragana}\\p{sc=Katakana}\\p{sc=Hangul}';
const TOKEN = new RegExp(`[${CJK}]|(?:(?![${CJK}])[\\p{L}\\p{N}])+`, 'gu');
// 平台没给认证类型（creator.org 为 null）时，按名字认明显的机构号
const ORG_NAME = /官方|官号|旗舰|俱乐部|赛事|集团|公司|电视台|新闻|日报|新华|央视|人民网|传媒|\b(?:newsroom|official|news|tv|studios?|inc|ltd|corp|records|entertainment|media|network)\b/i;

export const wordCount = (s) => (String(s ?? '').match(TOKEN) ?? []).length;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const flat = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

function readBody(out, file) {
  try {
    const raw = fs.readFileSync(path.join(out, file), 'utf8');
    return raw.slice(raw.indexOf('\n\n') + 2).split(HOT)[0].trim();
  } catch { return null; }
}

// 视频只数口播 / 字幕部分：text+asr 是「简介 + 转写」，去掉简介
function speechPart(w, text) {
  const src = w.copy?.source;
  if (src === 'subtitle' || src === 'asr') return text;
  if (src !== 'text+asr') return '';
  if (text.includes('【视频转写】')) return text.split('【视频转写】')[1];
  const desc = (w.desc ?? '').trim();
  return desc && text.startsWith(desc) ? text.slice(desc.length) : text;
}

export function isOrg(creator, name) {
  if (creator?.org != null) return creator.org === true;
  return ORG_NAME.test(creator?.name ?? name ?? '');
}

// 一条代表作是否过门槛：返回 { ok, eff, duration } 或 { ok: false, why }
export function gate(w, platform, t, text) {
  if (!w.copy?.chars || text == null) return { ok: false, why: '没有文案' };
  const trunc = text.match(TRUNC);
  const body = text.replace(TRUNC, '');
  if (w.type === 'note') {
    const eff = wordCount(body.replace(/#[^\s#]+#?/g, ''));
    const min = platform === 'x' ? t.minTweet : t.minNote;
    return eff >= min ? { ok: true, eff, duration: null } : { ok: false, why: `正文 ${eff} 字` };
  }
  const duration = w.duration ?? (trunc ? +trunc[1] * 60 : null);
  if (duration != null && duration < t.minVideoSec) return { ok: false, why: `时长 ${Math.round(duration)} 秒` };
  const eff = wordCount(speechPart(w, body));
  return eff >= t.minSpeech ? { ok: true, eff, duration } : { ok: false, why: eff ? `口播 ${eff} 字` : '没有有效语音' };
}

function readExcludes(out) {
  const f = path.join(out, '精选排除.txt');
  if (!fs.existsSync(f)) return new Set();
  return new Set(fs.readFileSync(f, 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean));
}

export function curate(out, overrides = {}) {
  const t = { ...DEFAULTS, ...overrides };
  const excludes = readExcludes(out);
  const excluded = new Set();
  const days = fs.readdirSync(out).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && fs.existsSync(path.join(out, d, 'data.json'))).sort();

  // 同一天同一作品可能出现在全站榜、专精榜和关注账号里：留排名最好的一条，专精取并集
  const byDayWork = new Map();
  for (const day of days) {
    const data = JSON.parse(fs.readFileSync(path.join(out, day, 'data.json'), 'utf8'));
    // 关注账号当作专精里一个没有排名的「榜」，和榜单作者走同一套
    const followed = (data.focus ?? []).flatMap((f) => (f.accounts ?? []).map((x) => ({ ...x, name: x.input?.name, follow: true })));
    const sources = [
      ...(data.platforms ?? []).map((b) => ({ b, focus: b.focus ?? b.vertical ?? null, entries: b.entries ?? [] })),
      ...followed.map((x) => ({ b: { name: x.platform, label: x.label }, focus: x.focus, entries: [x] })),
    ];
    for (const { b, focus, entries } of sources) {
      for (const e of entries) {
        if (!e.works?.length || isOrg(e.creator, e.name)) continue;
        const rank = e.follow ? Infinity : e.rank;
        const banned = e.creator?.id != null && excludes.has(`${b.name}:${e.creator.id}`);
        const likes = e.works.map((w) => w.metrics?.likes).filter((x) => x != null);
        const med = likes.length >= 3 ? median(likes) : null;
        for (const w of e.works) {
          if (!w.representative || !w.copy?.file || w.sensitive === true) continue;
          const text = readBody(out, w.copy.file);
          const g = gate(w, b.name, t, text);
          if (!g.ok) continue;
          if (banned || excludes.has(String(w.id))) { excluded.add(`${b.name}|${w.id}`); continue; }
          const burst = med && w.metrics?.likes != null ? +(w.metrics.likes / med).toFixed(1) : null;
          const tags = [
            e.follow && '〔关注〕',
            w.pick === 'peak' && '〔峰值〕',
            burst != null && burst >= t.burst && `爆款系数 ${burst}`,
            rank <= t.topRank && `涨粉第 ${rank}`,
          ].filter(Boolean);
          const key = `${day}|${b.name}|${w.id}`;
          const old = byDayWork.get(key);
          if (old) {
            if (focus && !old.focus.includes(focus)) old.focus.push(focus);
            old.site ||= !focus;
            if (rank >= (old.rank ?? Infinity)) continue;
          }
          byDayWork.set(key, {
            date: day, platform: b.name, label: b.label, focus: old?.focus ?? (focus ? [focus] : []), site: old?.site || !focus,
            follow: !!e.follow, board: { period: b.board?.period ?? null, date: b.board?.date ?? null, category: b.category ?? null },
            rank: e.follow ? null : e.rank, gain: e.gain ?? null, followers: e.followers ?? e.creator?.followers ?? null,
            author: { name: e.creator?.name ?? e.name, id: e.creator?.id ?? null, url: e.creator?.url ?? null },
            work: { id: w.id, url: w.url, title: w.title || flat(w.desc, 40), type: w.type, published_at: w.published_at, duration: g.duration, metrics: w.metrics ?? {} },
            peak: w.pick === 'peak', burst, tags, language: w.copy.language ?? null,
            chars: g.eff, copy_file: w.copy.file, excerpt: flat(text.replace(TRUNC, ''), 200),
          });
        }
      }
    }
  }

  // 跨天去重（留第一次入选那天），每天每平台每领域按 涨粉 → 峰值 → 爆款系数 排序取前几条；时长未知的视频排后
  const seen = new Set();
  const groups = new Map();
  for (const x of [...byDayWork.values()].sort((a, b) => a.date.localeCompare(b.date))) {
    const id = `${x.platform}|${x.work.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const g = `${x.date}|${x.platform}|${x.site ? '' : x.focus[0]}`;
    groups.set(g, [...(groups.get(g) ?? []), x]);
  }
  const unknown = (x) => x.work.type === 'video' && x.work.duration == null;
  const items = [...groups.values()].flatMap((xs) => xs
    .sort((a, b) => a.follow - b.follow || unknown(a) - unknown(b) || (b.gain ?? 0) - (a.gain ?? 0) || b.peak - a.peak || (b.burst ?? 0) - (a.burst ?? 0))
    .slice(0, t.maxPerDay));
  items.sort((a, b) => b.date.localeCompare(a.date) || (b.gain ?? 0) - (a.gain ?? 0));

  fs.writeFileSync(path.join(out, '精选库.jsonl'), items.map((x) => JSON.stringify(x)).join('\n') + (items.length ? '\n' : ''));
  fs.writeFileSync(path.join(out, '精选库.md'), libraryMarkdown(items, t));
  return { items, excluded: excluded.size, thresholds: t, days };
}

// ---------- 展示 ----------

export const num = (n) => {
  if (n == null || Number.isNaN(+n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e8) return `${+(n / 1e8).toFixed(2)}亿`;
  if (a >= 1e4) return `${+(n / 1e4).toFixed(1)}万`;
  return String(n);
};
// 计入全站名额的只标平台；只从专精入选的才标「平台 · 专精」（focus 字段照旧保留全部）
const place = (x) => (x.site ? x.label : [x.label, ...x.focus].join(' · '));
const growth = (x) => (x.follow ? `总粉 ${num(x.followers)}` : `+${num(x.gain)} / ${num(x.followers)}`);
export const clock = (s) => (s == null ? '—' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);
const esc = (s) => String(s ?? '').replace(/[[\]|]/g, '\\$&');

// 一条精选的单行摘要；linkBase 是从所在文件到 <out> 的相对路径（日报里是 '../'）
export function itemLine(x, linkBase = '') {
  const m = x.work.metrics;
  const where = place(x);
  const stats = `播放 ${num(m.plays)} / 赞 ${num(m.likes)} / 评 ${num(m.comments)} / 藏 ${num(m.collects)} / 转 ${num(m.shares)}`;
  return `〔${where}〕${esc(x.author.name)}（${growth(x)}）[${esc(x.work.title) || '（无标题）'}](${x.work.url})`
    + ` · ${x.work.type === 'note' ? '图文' : `时长 ${clock(x.work.duration)}`} · ${stats}`
    + `${x.burst != null ? ` · 爆款系数 ${x.burst}` : ''}${x.tags.length ? ` · ${x.tags.join('、')}` : ''}${x.language ? ` · 语言 ${x.language}` : ''}`
    + ` · [文案 ${x.chars} 字](${linkBase}${x.copy_file})`;
}

function libraryMarkdown(items, t) {
  const lines = [
    '# 精选库', '',
    `门槛：视频 ≥ ${t.minVideoSec} 秒且口播 / 字幕 ≥ ${t.minSpeech} 字；图文正文 ≥ ${t.minNote} 字；推文 ≥ ${t.minTweet} 字；机构号、平台标为敏感的不收。`
    + `标签：〔峰值〕、爆款系数 ≥ ${t.burst}（点赞 / 作者窗口内作品点赞中位数）、涨粉前 ${t.topRank}、〔关注〕（专精里的关注账号）。每天每平台每专精按 涨粉 → 峰值 → 爆款系数 留前 ${t.maxPerDay} 条，关注账号排在榜单作者之后。`,
    '', `共 ${items.length} 条。`, '',
  ];
  let day = null;
  for (const x of items) {
    if (x.date !== day) {
      day = x.date;
      lines.push(`## ${day}（${items.filter((y) => y.date === day).length} 条）`, '');
    }
    const w = x.work;
    lines.push(
      `### ${place(x)} · ${esc(x.author.name)}`, '',
      `- 作者：${x.author.url ? `[${esc(x.author.name)}](${x.author.url})` : esc(x.author.name)}，${x.follow ? `总粉 ${num(x.followers)}（关注账号）` : `涨粉 +${num(x.gain)} / 总粉 ${num(x.followers)}（${x.board.period ?? '榜单'} 第 ${x.rank}）`}`,
      `- 作品：[${esc(w.title) || '（无标题）'}](${w.url}) · 发布 ${String(w.published_at ?? '').slice(0, 16).replace('T', ' ')} · ${w.type === 'note' ? '图文' : `时长 ${clock(w.duration)}`}`,
      `- 数据：播放 ${num(w.metrics.plays)} / 赞 ${num(w.metrics.likes)} / 评 ${num(w.metrics.comments)} / 藏 ${num(w.metrics.collects)} / 转 ${num(w.metrics.shares)}${x.burst != null ? ` · 爆款系数 ${x.burst}` : ''}`,
      `- 标签：${x.tags.join('、') || '—'}${x.language ? ` · 转写语言 ${x.language}` : ''}`,
      `- 文案（${x.chars} 字）：${esc(x.excerpt)} [全文](${x.copy_file})`, '',
    );
  }
  return lines.join('\n');
}

// ---------- 命令行 ----------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values: a } = parseArgs({
    options: {
      out: { type: 'string' },
      'min-video-sec': { type: 'string' }, 'min-speech': { type: 'string' }, 'min-note': { type: 'string' }, 'min-tweet': { type: 'string' },
      burst: { type: 'string' }, 'top-rank': { type: 'string' }, 'max-per-day': { type: 'string' },
    },
  });
  if (!a.out) {
    console.error('用法：node scripts/curate.mjs --out <日报目录> [--min-video-sec 60] [--min-speech 300] [--min-note 150] [--min-tweet 140] [--burst 3] [--top-rank 3] [--max-per-day 4]');
    process.exit(2);
  }
  const map = { 'min-video-sec': 'minVideoSec', 'min-speech': 'minSpeech', 'min-note': 'minNote', 'min-tweet': 'minTweet', burst: 'burst', 'top-rank': 'topRank', 'max-per-day': 'maxPerDay' };
  const overrides = Object.fromEntries(Object.entries(map).filter(([k]) => a[k] != null).map(([k, v]) => [v, +a[k]]));
  const out = path.resolve(a.out);
  const { items, excluded, thresholds, days } = curate(out, overrides);
  const per = {};
  for (const x of items) per[x.date] = (per[x.date] ?? 0) + 1;
  console.log(JSON.stringify({ items: items.length, excluded, days: days.length, per_day: per, thresholds, library: path.join(out, '精选库.md') }));
}
