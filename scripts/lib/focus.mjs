// 额外专精：一个专精 = 若干分类涨粉榜 + 想长期关注的账号。
// 专精文件按名字在 <out>/focus/、仓库 focus/ 里找（用户的优先），也可以直接给路径；自媒体工作台导出的采集清单（kind=mwb-watchlist）本身就是专精文件。
// 来自采集清单的专精跑完另写一份竞对数据包（kind=zhangfen-watch v1）：外部工作台按它导入，只能加字段，不能改名或删字段。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PRESETS = fileURLToPath(new URL('../../focus/', import.meta.url));

export function loadFocus(spec, out) {
  const isPath = spec.includes('/') || spec.endsWith('.json');
  const file = isPath ? path.resolve(spec) : [path.join(out, 'focus', `${spec}.json`), path.join(PRESETS, `${spec}.json`)].find((f) => fs.existsSync(f));
  const name = isPath ? path.basename(spec, '.json') : spec;
  if (!file || !fs.existsSync(file)) return { name, boards: [], accounts: [], error: `找不到专精「${spec}」${isPath ? '' : `（${out}/focus/ 和仓库 focus/ 下都没有 ${spec}.json）`}` };
  let j;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { name, file, boards: [], accounts: [], error: `${file} 不是合法的 JSON（${e.message}）` }; }
  return {
    name: j.name || path.basename(file, '.json'), file, watchlist: j.kind === 'mwb-watchlist',
    boards: [...new Set(j.boards ?? [])], accounts: j.accounts ?? [], top: j.top,
  };
}

// ---------- 竞对数据包 ----------

const HOT = '\n## 热评\n';
const byLikes = (x, y) => (y.metrics?.likes ?? -1) - (x.metrics?.likes ?? -1);

// 文案缓存 copy/<平台>/<ID>.txt → { source, text, comments }（数据包里内嵌文案和热评）
function copyOf(out, file) {
  const raw = fs.readFileSync(path.join(out, file), 'utf8');
  const i = raw.indexOf('\n\n');
  const [body, hot = ''] = raw.slice(i + 2).split(HOT);
  const comments = hot.split('\n').map((l) => l.match(/^- (.*)（赞 ([\d—]+)）$/)).filter(Boolean)
    .map((m) => ({ text: m[1], likes: m[2] === '—' ? null : +m[2] }));
  return { source: raw.slice(0, i).match(/^来源：(.+)$/m)?.[1] ?? 'text', text: body.trim(), comments: comments.slice(0, 10) };
}

// 只留工作台用得到的字段；文案为空（视频里没有人声、正文也空）的不算带文案，工作台只收带文案的作品
function slim(out, w) {
  let copy = null;
  try { if (w.copy?.file) copy = copyOf(out, w.copy.file); } catch {}
  const empty = copy && !copy.text;
  return {
    id: w.id, url: w.url, title: w.title, type: w.type, published_at: w.published_at,
    duration: Math.round(w.duration ?? w.media?.duration ?? 0) || null, metrics: w.metrics, desc: w.desc ?? '',
    ...(copy && !empty ? { copy } : {}),
    ...(empty ? { copy_error: '没有可用文案（视频里没有人声）' } : w.copy_error ? { copy_error: w.copy_error } : {}),
  };
}

export function writePack(out, file, f, result) {
  const pack = {
    kind: 'zhangfen-watch', version: 1, date: result.date, generated_at: new Date().toISOString(), window: result.opts.window,
    accounts: [], boards: [], skipped: [], focus: f.name,
  };
  for (const x of f.accounts) {
    if (x.skipped) { pack.skipped.push({ input: { ...x.input, platform: x.platform }, reason: x.skipped }); continue; }
    pack.accounts.push({
      ref: x.ref, platform: x.platform, label: x.label, input: x.input,
      works: [...(x.works ?? [])].sort(byLikes).map((w) => slim(out, w)),
      ...(x.creator ? { creator: x.creator } : {}), ...(x.note ? { note: x.note } : {}), ...(x.error ? { error: x.error } : {}),
    });
  }
  for (const b of result.platforms.filter((p) => p.focus === f.name)) {
    pack.boards.push({
      platform: b.name, label: b.label, category: b.category,
      entries: b.entries.map((e) => ({
        rank: e.rank, name: e.name, gain: e.gain, followers: e.followers, creator: e.creator ?? null,
        works: [...(e.works ?? [])].sort(byLikes).slice(0, 3).map((w) => slim(out, w)), ...(e.error ? { error: e.error } : {}),
      })),
      ...(b.board ? { date: b.board.date, period: b.board.period, url: b.board.url } : {}), ...(b.error ? { error: b.error } : {}),
    });
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(pack, null, 1));
  return pack;
}
