# 涨粉榜日报｜Daily Creator-Growth Digest across Chinese & Global Platforms

Collect daily creator-growth leaderboards from Bilibili, Douyin, Xiaohongshu, Kuaishou, YouTube and X (plus a popularity chart for WeChat Channels), then fetch each rising creator's recent works, metrics, scripts (subtitles, speech transcripts, post text) and top comments into one daily report.

每天谁在涨粉？靠的是哪条作品？作品里说了什么，观众又在评论什么？这个 Skill 把 B站、抖音、小红书、快手、YouTube、X 的涨粉榜和视频号热度榜的前列作者拉下来，找到他们榜期附近的作品和数据，再把代表作的文案取齐（平台字幕、口播转写、笔记和推文正文），生成一份能直接读的日报。Agent 读完文案，在日报末尾写几段观察。

采集全部在后台进行：浏览器用无头模式启动，不弹窗口、不抢焦点，也不碰你正在用的 Chrome。

## 日报长什么样

```markdown
# 涨粉榜日报 2026-11-03

B站 滚动7日（11-03） ｜ 抖音 日榜（11-02） ｜ 小红书 日榜（11-02） ｜ YouTube 日榜（11-01） ｜ …

## 抖音 · 日榜 · 2026-11-02

| 排名 | 作者 | 涨粉 | 总粉 | 窗口作品数 | 代表作 | 文案 |
|---|---|---|---|---|---|---|
| 1 | 某某 连续 3 天 | +71.6万（6%） · 峰值 10-31 | 1203万 | 4 | 〔峰值〕某条作品 赞 52万<br>另一条作品 赞 30万 | 简介+转写 1830字<br>简介 120字 |
...

## 观察

（Agent 根据代表作文案和热评补写）
```

同时输出 `data.json`（完整结构化数据）。文案存成单独的 txt，末尾附前 10 条热评，按作品 ID 缓存；同一位作者连续几天上榜时，已经取过的文案不会重复下载和转写。

## 工作方式

| 平台 | 涨粉榜来源 | 作品与数据 | 文案 |
|---|---|---|---|
| B站 | [zeroroku](https://zeroroku.com/rank) 滚动 7 日 | 投稿列表 + 视频详情 | AI 字幕；没有字幕就转写音频 |
| 抖音 | 飞瓜公开日榜 | 无头浏览器打开创作者主页 | 简介 + 口播转写 |
| 小红书 | 千瓜公开日榜 | 无头浏览器搜索作者（比对头像、昵称、粉丝量确认身份）→ 主页 → 笔记详情 | 标题 + 正文；视频笔记再加转写 |
| 快手 | 新榜快手涨粉日榜（需登录新榜免费账号；未登录时只有新快预览的近 7 日前 3 名） | 无头浏览器打开快手直播站主页 | 描述 + 口播转写 |
| 视频号 | 友望指数热度日榜（视频号不公开粉丝数，没找到可核验的公开涨粉榜，这是最接近的替代） | 友望作品列表（需微信扫码登录友望） | 作品描述 |
| YouTube | [viewstats](https://www.viewstats.com) 昨日涨订阅榜（只看创作者频道，不含儿童、音乐和影视预告频道） | 频道 RSS + yt-dlp | 原语言字幕；没有字幕就转写音频 |
| X | [xpaiming](https://xpaiming.com) 昨日涨粉榜（跟踪约 700 个账号的快照差，默认取中文内容分组） | 无头浏览器打开主页时间线（需登录 x.com） | 推文全文；视频推文再转写 |

- **榜期**：每轮取各榜最新一期已发布的榜，并写明真实榜期。飞瓜、千瓜都在次日约 8 点发布前一天的榜，所以建议每天 9 点以后运行。榜单当天还没更新时，报告会注明沿用的是哪一期。
- **在榜情况**：和前一天的 `data.json` 比对，标出「新进」或「连续 N 天」。
- **作品窗口与代表作**：只看榜期结束日前 14 天内发布的作品。能拿到逐日涨粉曲线的平台（B站、抖音、YouTube、X）会标出窗口内的涨粉峰值日，并优先选峰值日前后发布的作品作代表作（标〔峰值〕，表示时间上最接近，不代表就是它带来的涨粉），其余名额按点赞选。YouTube 的公开订阅数是取整后的，它的峰值其实是订阅数跳变的日子。
- **热评**：B站、小红书、YouTube、X 的代表作附前 10 条热评。
- **登录态**：每轮把日常 Chrome 的 Cookies 用 SQLite 快照复制到一个临时目录，用正版 Chrome 以无头模式启动。一个平台一个实例，跑完关闭，并删掉临时目录。
- **转写**：本地 [mlx-whisper](https://github.com/ml-explore/mlx-examples/tree/main/whisper) 加 whisper-large-v3-turbo，不上传任何音频，按作品语言识别。会过滤 whisper 在纯音乐上常编出的句子（如「字幕志愿者 ×××」「Thanks for watching」），这类视频显示「未转出有效语音」。超过 30 分钟的视频只转写前 30 分钟，文案末尾会注明。
- **额外专精**：日报之外可以叠加自己关心的领域，每个专精是这个领域的分类涨粉榜加上你想长期盯的账号，用 `--focus` 选，见下文「额外专精」。同一位作者同一天在几处出现只采一次。
- **精选库**：每天把代表作里「有分量的文案」筛出来，跨天去重累积到 `<out>/精选库.md`（另有 `精选库.jsonl`）。门槛：视频 ≥60 秒且口播 ≥300 字，图文 ≥150 字，推文 ≥140 字；去掉机构、企业、官媒账号和平台标记的敏感内容；每天每平台每个领域最多 4 条，按作者涨粉、〔峰值〕、爆款系数（作品点赞 ÷ 作者窗口内作品点赞中位数）排序。关注账号的代表作同样过门槛、标〔关注〕。当天新入选的列在日报的「今日精选」。平台没标出的不合适内容，把作品 ID 写进 `<out>/精选排除.txt` 再运行 `node scripts/curate.mjs --out <out>` 即可；改了阈值也是重跑这条命令全量重建。
- **并行与资源**：两个平台同时跑，转写排队、同一时刻只跑一个，实际内存峰值约 2.5–3GB。七个平台冷启动约 20 分钟，加上两个领域约 35 分钟；作者连续上榜、文案有缓存时快得多。
- **出错时**：某个平台或作者失败，就在日报里写明原因，继续跑其余部分。整轮有时间预算（默认 60 分钟），超出后不再开始新的作者或文案。
- **作者身份**：确认过的身份缓存在 `<out>/cache/`，同一位作者再上榜时不用重新找。

## 环境要求

- macOS，Apple Silicon（mlx-whisper 需要）
- [Google Chrome](https://www.google.com/chrome/)，并在里面登录要跑的平台：B站、抖音、小红书、快手、x.com；快手榜单要登录 [新榜](https://www.newrank.cn)，视频号作品要登录 [友望](https://www.youwant.cn)（都是免费账号）
- Node.js ≥ 22（只用内置模块，不需要 `npm install`）
- 装好 `mlx-whisper` 和 `yt-dlp` 的 Python，以及 ffmpeg：

  ```bash
  pip install mlx-whisper "yt-dlp[default]"
  brew install ffmpeg
  huggingface-cli download mlx-community/whisper-large-v3-turbo
  ```

  脚本会自动寻找能 `import mlx_whisper` 的 Python；找不到时用 `--python` 或环境变量 `ZF_PYTHON` 指定。yt-dlp 可用 `ZF_YTDLP` 指定可执行文件。
- 访问 YouTube、X 需要网络能连上这两个站。

## 安装

把仓库放进 Agent 的 skills 目录：

```bash
git clone https://github.com/ruodou233/zhangfen-daily.git ~/.workbuddy/skills/zhangfen-daily   # WorkBuddy
git clone https://github.com/ruodou233/zhangfen-daily.git ~/.claude/skills/zhangfen-daily      # Claude Code
git clone https://github.com/ruodou233/zhangfen-daily.git ~/.codex/skills/zhangfen-daily       # Codex
```

然后对 Agent 说「跑一下今天的涨粉榜」。

## 每天定时

以 WorkBuddy 为例：新建一个自动化，绑定 `zhangfen-daily` 这个 Skill，每天 9 点以后运行，提示词写一句就够：

> 用 zhangfen-daily 跑今天的涨粉榜，写好观察后交付日报。

其他支持定时任务的 Agent 也一样。只想要数据、不需要观察的话，用系统定时任务直接跑脚本即可。

## 直接运行脚本

```bash
node scripts/run.mjs --out ~/Documents/涨粉榜
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--out` | （必填） | 输出目录 |
| `--platforms` | 全部七个 | `bilibili,xhs,youtube,douyin,x,kuaishou,channels` 中任选 |
| `--top` | `10` | 每个榜取前几名 |
| `--copy` | `2` | 每位作者取几条代表作文案 |
| `--window` | `14` | 作品窗口天数 |
| `--concurrency` | `2` | 同时跑几个平台 |
| `--focus` | 不跑 | 逗号分隔的专精名或专精文件路径，见下文「额外专精」 |
| `--focus-top` | `5` | 专精里每个分类榜取前几名（专精文件里的 `top` 优先） |
| `--no-site` | — | 不跑全站榜，只跑专精 |
| `--budget-min` | `60` | 整轮时间预算（分钟） |
| `--chrome-profile` | `~/Library/Application Support/Google/Chrome` | 日常 Chrome 的用户数据目录 |
| `--python` | 自动探测 | 装了 mlx-whisper 的 Python |

| 环境变量 | 说明 |
|---|---|
| `ZF_YT_REGION` | YouTube 只看某些国家或地区的频道，如 `TW,HK`；不设为全球榜 |
| `ZF_X_COUNTRY` | X 榜单分组，默认 `cn`（中文内容）；`global` 为全部跟踪账号，也可选 `us`、`jp`、`kr` 等 |
| `ZF_PYTHON` / `ZF_YTDLP` | 指定 Python 解释器 / yt-dlp 可执行文件 |

产物结构：

```
<out>/
  2026-11-03/report.md     # 日报
  2026-11-03/data.json     # 完整数据
  copy/<平台>/<作品ID>.txt  # 文案缓存（含热评）
  cache/                   # 作者身份缓存
  精选库.md / 精选库.jsonl   # 跨天累积的精选文案
  精选排除.txt              # 手工排除名单（可选）
  focus/<名字>.json         # 你自己的专精（可选）
```

## 额外专精

全站涨粉榜之外，你多半还有自己的赛道：做教育的想看教育、母婴赛道谁在涨，做 AI 的想盯几个同行。专精就是为这个准备的，一个专精是一个 JSON 文件：

```json
{ "name": "AI科技",
  "boards": ["douyin:科技", "xhs:科技数码", "bilibili:科技", "youtube:Science & Technology"],
  "accounts": [ { "platform": "douyin", "name": "某个同行", "url": "https://www.douyin.com/user/MS4wLjAB..." } ],
  "top": 5 }
```

- `boards`：这个领域的分类涨粉榜，写成 `平台:分类`。分类名见各平台模块的 `CATEGORIES`，例如抖音（飞瓜）：亲子、教育校园、母婴、科技；小红书（千瓜）：教育、母婴育儿、科技数码；B站：科技；YouTube：Science & Technology；视频号（友望）：教育、科技、互联网。
- `accounts`：想长期盯的账号，给主页链接即可。支持抖音 `douyin.com/user/…` 或 `v.douyin.com` 短链、小红书 `xiaohongshu.com/user/profile/…` 或 `xhslink.com` 短链、B站 `space.bilibili.com/…` 或 `b23.tv` 短链；不支持的会在报告里写明。
- 仓库自带两个预设：`focus/教育母婴.json`、`focus/AI科技.json`，只有分类榜。想加账号或改分类，把它复制到 `<out>/focus/` 再改；同名时优先用 `<out>/focus/` 里的，你的私人关注列表不会混进仓库。

```bash
node scripts/run.mjs --out ~/Documents/涨粉榜 --focus 教育母婴,AI科技       # 全站榜 + 两个专精
node scripts/run.mjs --out ~/Documents/竞对监控 --no-site --focus 采集清单.json   # 只跑一个专精文件
```

报告里每个专精单独一节：先是各分类榜，再是「关注账号」。关注账号的作品、代表作、文案和热评，和榜单作者的取法一样。

**配合自媒体工作台**：工作台「竞对矩阵」导出的采集清单（`kind: mwb-watchlist`）本身就是一个专精文件，直接传给 `--focus`。跑完会多写一个 `<out>/<日期>/竞对数据包-<日期>.json`，回到工作台点「导入」：新爆款进爆款库待拆解，赛道榜可以一键加为竞对。

## 范围与限制

- 每天一轮，每位作者只看主页第一页；作品多的作者只取窗口内最近一部分，报告会注明。专精里的关注账号同样如此。
- 视频号榜单是友望指数（综合互动数据），不是涨粉榜，报告里写明了。
- X 的榜单只覆盖 xpaiming 跟踪的账号，不是全站榜；日增长是约 6 小时一次的快照差。
- 抖音、快手网页端拿不到别人作品的精确播放数；小红书、YouTube 的部分数字是页面上的取整值。
- 几个数据源用的是网页自己调用的接口，平台改版时可能失效；失效的平台会在日报里写明原因。

## License

MIT
