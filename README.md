# 涨粉榜日报｜Daily Follower-Growth Digest for Bilibili, Douyin & Xiaohongshu

Collect the daily follower-growth leaderboards of Bilibili, Douyin and Xiaohongshu, then fetch each rising creator's recent works, metrics and scripts (subtitles, speech transcripts, note text) into one daily report.

每天谁在涨粉？靠的是哪条作品？作品里说了什么？这个 Skill 把 B站、抖音、小红书三个涨粉榜的前列作者拉下来，找到他们榜期附近的作品和数据，再把代表作的文案取齐（B站 AI 字幕、口播转写、笔记正文），生成一份能直接读的日报。Agent 读完文案，在日报末尾写几段观察。

采集全部在后台进行：浏览器用无头模式启动，不弹窗口、不抢焦点，也不碰你正在用的 Chrome。

## 日报长什么样

```markdown
# 涨粉榜日报 2026-11-03

B站 滚动7日（2026-11-03） ｜ 抖音 日榜（2026-11-02） ｜ 小红书 日榜（2026-11-02）

## 抖音 · 日榜 · 2026-11-02

| 排名 | 作者 | 涨粉 | 总粉 | 窗口作品数 | 代表作 | 文案 |
|---|---|---|---|---|---|---|
| 1 | 某某 | +71.6万 | 1203万 | 4 | 某条作品标题 赞 52万 | 简介+转写 1830字 |
...

## 观察

（Agent 根据代表作文案补写）
```

同时输出 `data.json`（完整结构化数据），文案存成单独的 txt，按作品 ID 缓存。同一位作者连续几天上榜时，已经取过的文案不会重复下载和转写。

## 工作方式

| 平台 | 涨粉榜来源 | 作品与数据 | 文案 |
|---|---|---|---|
| B站 | [zeroroku](https://zeroroku.com/rank) 滚动 7 日 | 投稿列表 + 视频详情 | AI 字幕；没有字幕就转写音频 |
| 抖音 | 飞瓜公开日榜 | 无头浏览器打开创作者主页 | 简介 + 口播转写 |
| 小红书 | 千瓜公开日榜 | 无头浏览器搜索作者（比对头像、昵称、粉丝量确认身份）→ 主页 → 笔记详情 | 标题 + 正文；视频笔记再加转写 |

- **榜期**：每轮取各榜最新一期已发布的榜，并写明真实榜期。飞瓜、千瓜都在次日约 8 点发布前一天的榜，所以建议每天 9 点以后运行。
- **作品窗口**：只看榜期结束日前 14 天内发布的作品，按点赞取前 2 条代表作去拿文案。
- **登录态**：每轮把日常 Chrome 的 Cookies 用 SQLite 快照复制到一个临时目录，用正版 Chrome 以无头模式启动。一个平台一个实例，跑完关闭，并删掉临时目录。你只需要在日常 Chrome 里保持 B站、抖音、小红书的登录。
- **转写**：本地 [mlx-whisper](https://github.com/ml-explore/mlx-examples/tree/main/whisper) 加 whisper-large-v3-turbo，不上传任何音频。会过滤 whisper 在纯音乐上常编出的句子（如「字幕志愿者 ×××」），这类视频显示「未转出有效语音」。超过 30 分钟的视频只转写前 30 分钟，文案末尾会注明。
- **出错时**：某个平台或作者失败，就在日报里写明原因，继续跑其余部分。整轮有时间预算（默认 30 分钟），超出后不再开始新的作者或文案。
- **作者身份**：抖音按飞瓜给出的 uid 定位作者，小红书比对头像、昵称、粉丝量，确认后都会缓存在 `<out>/cache/`，同一位作者再上榜时不用重新找。

## 环境要求

- macOS，Apple Silicon（mlx-whisper 需要）
- [Google Chrome](https://www.google.com/chrome/)，并登录 B站、抖音、小红书
- Node.js ≥ 22（只用内置模块，不需要 `npm install`）
- 装好 `mlx-whisper` 的 Python，以及 ffmpeg：

  ```bash
  pip install mlx-whisper
  brew install ffmpeg
  huggingface-cli download mlx-community/whisper-large-v3-turbo
  ```

  脚本会自动寻找能 `import mlx_whisper` 的 Python；找不到时用 `--python` 或环境变量 `ZF_PYTHON` 指定。

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
| `--platforms` | `bilibili,douyin,xhs` | 要跑的平台 |
| `--top` | `10` | 每个榜取前几名 |
| `--copy` | `2` | 每位作者取几条代表作文案 |
| `--window` | `14` | 作品窗口天数 |
| `--budget-min` | `30` | 整轮时间预算（分钟） |
| `--chrome-profile` | `~/Library/Application Support/Google/Chrome` | 日常 Chrome 的用户数据目录 |
| `--python` | 自动探测 | 装了 mlx-whisper 的 Python |

产物结构：

```
<out>/
  2026-11-03/report.md     # 日报
  2026-11-03/data.json     # 完整数据
  copy/<平台>/<作品ID>.txt  # 文案缓存
  cache/                   # 作者身份缓存
```

## 范围

目前覆盖 B站、抖音、小红书。快手和视频号暂时没有可用的公开日涨粉榜，所以没有纳入。每天一轮，每位作者只看主页第一页；B站作品多的作者只取窗口内最近 10 条。

## License

MIT
