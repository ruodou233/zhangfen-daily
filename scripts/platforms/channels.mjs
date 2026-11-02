// 视频号：平台不公开粉丝数，没有哪家能给真实的涨粉榜。榜单用友望「行业排行榜·日榜」（友望指数，免登录 HTML），
// 作者 ID 是友望的 bloggerId/key。作品列表走友望 API，要在日常 Chrome 登录 youwant.cn。文案 = 友望给的作品描述。
// 视频号自己的网页版只在微信客户端里通过 JSBridge 取数，浏览器里拿不到，所以不走原站。

export const label = '视频号';

const YW = 'https://www.youwant.cn';
const API = 'https://api.youwant.cn';
const DAY = 86_400_000;
const CST = 8 * 3_600_000;
const LOGIN_HINT = '日常 Chrome 登录 youwant.cn 后重跑';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cstISO = (ms) => new Date(ms + CST).toISOString().replace(/\.\d+Z$/, '+08:00');
const unescape = (s) =>
  s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .trim();
// '1.71w' → 17100，'10w+' → 100000（友望封顶显示，是下限），'--' 等认不出的给 null
const num = (s) => {
  if (typeof s === 'number') return s;
  const m = String(s ?? '').replace(/[,+\s]/g, '').match(/^([\d.]+)(w|万|亿)?$/i);
  return m ? Math.round(parseFloat(m[1]) * ({ w: 1e4, 万: 1e4, 亿: 1e8 }[m[2]?.toLowerCase()] ?? 1)) : null;
};

// ---------- 榜单 ----------

// /rank 会 301 到最新一期日榜。页面的日期下拉只列已发布的期次（第一项最新），当前期带 class="active"
export async function board(ctx) {
  const res = await ctx.http.request(`${YW}/rank`);
  if (!res.ok) throw new Error(`友望榜单页 HTTP ${res.status}`);
  const html = await res.text();
  const ymd = res.url.match(/\/rank\/blogger\/1\/(\d{8})\/0\.html/)?.[1];
  const sel = html.match(/id="date-select"[\s\S]*?<\/ul>/)?.[0] ?? '';
  const dates = [...sel.matchAll(/<li class="([^"]*)" data-val="(\d{8})"/g)].map(([, cls, d]) => ({ d, active: /active/.test(cls) }));
  if (!ymd || !dates.length) throw new Error(`友望榜单页里没找到期次（落到 ${res.url}），页面结构可能变了`);
  if (dates[0].d !== ymd || !dates.find((x) => x.active && x.d === ymd)) throw new Error(`友望 /rank 跳到的 ${ymd} 期不是期次列表里的最新一期（${dates[0].d}），无法确认榜期`);

  const list = html.split('<ul class="lists">')[1]?.split('</ul>')[0] ?? '';
  const entries = [];
  for (const [, li] of list.matchAll(/<li>([\s\S]*?)<\/li>/g)) {
    const [, id, key] = li.match(/\/home\/#\/blogger\/detail\/(\d+)\/(\w+)/) ?? [];
    const rank = li.match(/rank-new(\d)\.png/)?.[1] ?? li.match(/class="number">\s*(\d+)/)?.[1];
    const name = li.match(/<p>([^<]*)<\/p>/)?.[1];
    if (!id || !rank || !name) continue;
    // 名字那一栏之后依次是：预估粉丝数、日作品数、平均点赞、平均转发、平均收藏、平均评论、友望指数
    const [fans, works, likes, shares, collects, comments, index] = [...(li.split(/<\/object>\s*<\/div>/)[1] ?? '').matchAll(/<div[^>]*>([^<]*)<\/div>/g)].map((m) => m[1].trim());
    entries.push({
      rank: +rank,
      name: unescape(name),
      gain: null, // 视频号不公开粉丝数，没有涨粉数据
      followers: null, // 友望的「预估粉丝数」是按互动量估的档位，不当粉丝数用，放在 ref.fans_estimate
      ref: {
        id, key,
        avatar: li.match(/<img src="([^"]+)"[^>]*class="head-img"/)?.[1] ?? null,
        tag: unescape(li.match(/profession-tag[\s\S]*?<span>([^<]*)<\/span>/)?.[1] ?? ''),
        fans_estimate: fans ?? null,
        index: parseFloat(index) || null,
        day: { works: num(works), avg_likes: num(likes), avg_shares: num(shares), avg_collects: num(collects), avg_comments: num(comments) },
      },
    });
  }
  if (!entries.length) throw new Error(`友望 ${ymd} 期日榜没解析出条目`);
  if (ctx.opts.top > entries.length) ctx.log(`友望公开页只列前 ${entries.length} 名（更多要登录），取 ${entries.length} 位`);
  return {
    date: `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6)}`,
    period: '热度日榜（友望指数，非涨粉）',
    url: `${YW}/rank/blogger/1/${ymd}/0.html`,
    entries: entries.slice(0, ctx.opts.top),
  };
}

// ---------- 友望 API（登录态） ----------

let cookie; // 一轮只取一次；没登录就记下原因，后面的作者直接报同样的错
let loginError = null;

async function api(ctx, path, params) {
  if (loginError) throw new Error(loginError);
  if (cookie === undefined) {
    cookie = await (await ctx.browser()).cookieHeader('api.youwant.cn');
    if (!cookie) loginError = `友望未登录，取不到作品列表（${LOGIN_HINT}）`;
  }
  if (loginError) throw new Error(loginError);
  await sleep(500);
  const j = await ctx.http.json(`${API}${path}?${new URLSearchParams(params)}`, {
    headers: { Cookie: cookie, Origin: YW, Referer: `${YW}/home/` },
  });
  if (j.Code === 401) {
    loginError = `友望登录已失效，取不到作品列表（${LOGIN_HINT}）`;
    throw new Error(loginError);
  }
  return j;
}

// 友望的时间有的是秒级时间戳，有的是 'YYYY-MM-DD HH:mm(:ss)' 北京时间
function toMs(v) {
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const m = String(v ?? '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  return m ? Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}+08:00`) : null;
}

export async function works(ctx, entry, board) {
  const { id, key } = entry.ref;
  const end = Date.parse(`${board.date}T23:59:59+08:00`);
  const start = end + 1000 - (ctx.opts.window + 1) * DAY;
  // 作者作品列表（友望详情页「作品」tab 的接口）：按发布时间倒序，第一页 30 条
  const j = await api(ctx, '/v1/blogger/getVideoList', {
    bloggerId: id, key, begin: Math.floor(start / 1000), end: Math.floor(end / 1000),
    actType: -1, productState: -1, newVideoType: -1, collectionState: -1, sortType: 3, pageIndex: 1, pageSize: 30,
  });
  if (j.Code !== 200 && !(j.Code === 402 && j.Data)) throw new Error(`友望作品接口返回 Code=${j.Code} ${j.Msg ?? ''}`.trim());
  const items = j.Data?.ItemList ?? [];
  const total = j.Data?.TotalCount ?? items.length;
  const list = items.map((v) => ({ v, ms: toMs(v.PubTime ?? v.PublishTime ?? v.PubTimeDesc) }));
  if (items.length && !list.some((x) => x.ms)) throw new Error(`友望作品列表里认不出发布时间（字段：${Object.keys(items[0]).join(',')}）`);

  const inWindow = list.filter((x) => x.ms >= start && x.ms <= end);
  ctx.log(`${entry.name}：友望作品列表 ${items.length}/${total} 条，窗口内 ${inWindow.length} 条`);
  return {
    creator: { id: `youwant:${id}`, name: entry.name, url: `${YW}/home/#/blogger/detail/${id}/${key}`, followers: null },
    works: inWindow.map(({ v, ms }) => {
      const dateCode = v.DateCode ?? v.VideoDateCode;
      const desc = unescape(String(v.Description ?? '')).trim();
      return {
        id: String(v.VideoId),
        url: `${YW}/home/#/videoAnalysis/detail/${v.VideoId}/${v.VideoIdKey}/${dateCode}`,
        title: (v.Title || desc.split('\n')[0]).slice(0, 60),
        type: 'video',
        published_at: cstISO(ms),
        // 视频号的「推荐」即点赞，「喜欢」记作收藏
        metrics: {
          plays: null,
          likes: num(v.LikeCount ?? v.LikeCountDesc), comments: num(v.CommentCount ?? v.CommentCountDesc),
          collects: num(v.FavCount ?? v.FavCountDesc), shares: num(v.ForwardCount ?? v.ForwardCountDesc),
        },
        desc,
        media: null,
      };
    }),
    note: total > items.length && inWindow.length === list.length ? `友望作品列表只取了第一页 ${items.length} 条（共 ${total} 条）` : '',
  };
}

export async function copy(ctx, work) {
  if (!work.desc) throw new Error('友望没有给这条作品的描述');
  return { source: 'text', text: work.desc };
}
