/**
 * mcp.js — 独立的 stdio MCP server：把 `see_now` 交给 Claude Code 这类 MCP 宿主。
 *
 * 为什么单独一份而不是复用 index.js：index.js 是 DSH 插件，带悬浮窗、声音、
 * 常驻循环、附件服务 —— 那些在 MCP 这边全都没有，也都不该有。这里只保留
 * "采集 → 攒图 → 把图当成 image block 返回"这一条最短路径，runner 以 headless 跑。
 *
 * **stdout 是 MCP 通道**：这里所有日志一律走 stderr（`log`），绝不能用 console.log，
 * 否则一条调试输出就会把 JSON-RPC 流打坏，宿主直接断连。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRunner, SCENE_OPTS, PACES, DEFAULT_PACE } from './runner.js';
import { resolveFfmpeg } from './binaries.js';
import { parseRegion } from './layout.js';
import { DEFAULT_BLOCK_SEC, TOOL_TIMEOUT_MS } from './tool-spec.js';
import { pickRegion, loadRegion, clearRegion, regionText } from './region.js';

/** 版本号：从 package.json 读（和 index.js 同一套写法），只为日志里能分清跑的是哪一版。 */
const VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch { return '?'; }
})();

/**
 * `watch` 最多阻塞多久。
 *
 * 必须比宿主的工具超时早收工：留 40 秒给建图/传输/模型想一想，
 * 否则到点不是"返回一张图"，而是整条调用被宿主 abort。
 */
const MAX_BLOCK_SEC = Math.max(30, Math.floor(TOOL_TIMEOUT_MS / 1000) - 40);

const TOOL_DESCRIPTION = `Watch the user's screen live (or replay a local video file) and get back one PNG image made of several frames. Frames are kept only when the picture changes, so a static screen costs almost nothing and a busy one gives more frames. Frames are numbered 1..n in time order; the text lists each frame's timestamp and pixel size. Result text is in Chinese.

Actions:
- watch (default): blocking. The first call returns the current screen within about a second. Later calls block until a sheet is ready (usually 15-40 s while the screen changes, up to \`seconds\` when it is static), then return it. To keep watching, call watch again after you reply. There is no background wake-up: if you stop calling, you see nothing new.
- peek: return a sheet that has already piled up, without waiting. Returns a short note if none is ready.
- start: begin capturing without waiting for an image. stop: stop capturing.
- status: whether capture is running, frames kept, queue, mode, pace and region.
- region: show a dim full-screen overlay so the user can drag a rectangle; later watch calls capture only that rectangle. region:"off" goes back to the full screen. Blocks until the user finishes (up to 3 minutes), so tell the user what to do before calling it.

Cost (Claude vision tokens per image): quality "low" 800x450 about 493, "standard" 1066x600 about 858, "high" 1280x720 about 1196, "ultra" 1600x900 about 1914. Do not poll faster than about every 10 seconds. If you cannot read something (small text, filenames), do not guess: call watch with quality:"high". Changing quality restarts capture and immediately returns one sharp frame of the current screen.`;

/**
 * 从工具参数构造 source 描述（和 index.js 同一套规则）。
 *
 * `region` 是 `source:"screen"` 的修饰参数：带 region 必须钉死 gdigrab
 * （ddagrab 没有偏移参数，带 offset 会静默抓整屏）；格式不对时明确报错，
 * 不能静默退化成全屏 —— 那会让用户以为框选生效了。
 *
 * @returns {{src: object|null, error?: string}}
 */
function srcOf(args) {
  const kind = args.source ? String(args.source).toLowerCase() : null;
  const src = kind ? { kind } : null;
  if (src && kind === 'file') {
    src.path = args.path;
    src.realtime = args.realtime === true;
  }
  const rawRegion = args.region;
  if (rawRegion === undefined || rawRegion === null || rawRegion === '') return { src };
  if (src && kind !== 'screen') {
    return { src: null, error: `region 只能配 source:"screen"，现在是 "${kind}"。` };
  }
  const region = parseRegion(rawRegion);
  if (!region) {
    return {
      src: null,
      error: `region 格式不对：「${String(rawRegion)}」。要 "x,y,w,h" 四个整数（屏幕物理像素，`
        + '和 desktop_control 的 window rect 同一套坐标），例如 "1593,375,568,1010"。'
        + '\n没有按全屏抓 —— 那会让你以为 region 生效了。',
    };
  }
  const out = src ?? { kind: 'screen' };
  out.region = region;
  out.engine = 'gdigrab';
  return { src: out };
}

/** 一张图 → 模型看得懂的清单（只保留 index.js 里和画面有关的部分，没有台词/插话/循环）。 */
function sheetText(sheet, { waited = 0, partial = false } = {}) {
  const { frames, from, to, why } = sheet;
  // 单帧时首尾相等，写成区间会变成"过去 24.1–24.1 秒"，读起来像出错了
  const span = frames.length === 1
    ? `此刻（第 ${frames[0].t.toFixed(1)} 秒）的 1 个画面`
    : `过去 ${from.toFixed(1)}–${to.toFixed(1)} 秒的 ${frames.length} 个画面`;
  const head = `${span} · ${sheet.w}×${sheet.h}`
    + `${partial ? '，还没攒满就截断了' : ''}`
    + `${waited ? ` · 等了 ${waited.toFixed(0)}s` : ''}`;
  const lines = frames.map((f, i) => {
    const cell = sheet.cells?.[i];
    const size = cell ? `${cell.pw}×${cell.ph}` : '—';
    // 档位要报两件事：算法给的档位，和它实际占多少画布。
    // 两者不一致是排布器为了塞进一张图把格子压小了。
    const k = cell ? Math.max(1, Math.round(sheet.w / Math.max(1, cell.pw))) : null;
    const tierText = k && k !== f.tier ? `${f.tier}档→1/${k}` : `${f.tier} 档`;
    return `  ${i + 1}. ${f.t.toFixed(1)}s · ${size} · ${f.via} · ${tierText}`;
  });
  const whyText = why === 'user' ? '用户插话截断的'
    : why === 'timeout' ? '等满了先给你'
      : why === 'time' ? '攒到这个点先给你'
        : why === 'full' ? '这张装满了'
          : why === 'first' ? '刚打开，先给你此刻'
            : why === 'oneshot' ? '换了清晰度，先给你此刻'
              : '流结束';
  return `${head}\n${lines.join('\n')}\n（${whyText}；想看下一段就再调一次 \`see_now({action:"watch"})\`。）`;
}

const textResult = (text) => ({ content: [{ type: 'text', text }] });
const errorResult = (text) => ({ content: [{ type: 'text', text }], isError: true });
const imageResult = (sheet, opts) => ({
  content: [
    { type: 'image', data: sheet.png.toString('base64'), mimeType: 'image/png' },
    { type: 'text', text: sheetText(sheet, opts) },
  ],
});

/**
 * 建一个还没接 transport 的 MCP server。
 *
 * @param {{ runner: object, log?: (m: string) => void, pickRegion?: typeof pickRegion }} o
 * @returns {McpServer}
 */
export function createSeeNowServer({ runner, log = () => {}, pickRegion: pick = pickRegion } = {}) {
  const server = new McpServer({ name: 'see-now', version: VERSION });

  /** 逐帧 / 逐场景模式（粘性，默认关） */
  let sceneMode = false;
  /** 节奏（粘性） */
  let paceMode = DEFAULT_PACE;
  /**
   * 上一次真正生效的 source 类型。`cutAbs` 的自动选择要靠它 ——
   * 后续 watch 通常不带 path，看本次 `src` 会把"文件回放"翻回默认档。
   */
  let lastSrcKind = null;
  /** 切模式/换区域那句说明：下一次结果带给模型，然后清掉 */
  let pendingNote = '';
  /** 上一次告诉模型的区域；变了才说一句 */
  let lastRegionKey = regionText(loadRegion());

  const inputSchema = {
    action: z.string().optional().describe('watch (default) | peek | start | stop | status | region'),
    source: z.string().optional().describe('"screen" (whole desktop, default), "obs" (OBS virtual camera), "camera" (first webcam), or "file" together with path to replay a local video. Only matters when capture starts.'),
    path: z.string().optional().describe('With source:"file": absolute path of the video.'),
    realtime: z.boolean().optional().describe('With source:"file": replay at 1x speed instead of as fast as ffmpeg can decode.'),
    region: z.string().optional().describe('Capture only a rectangle of the primary screen, "x,y,w,h" in physical pixels. Usually not needed: use action:"region" to let the user drag one; it is saved and used by later watch calls. "off" goes back to the full screen. Only what is visible on screen is captured (covered or minimized windows are not). Costs more tokens than full screen because frames are not shrunk.'),
    pace: z.string().optional().describe('"calm" | "normal" (default) | "dense" | "game-economic". How big a change counts as a new frame. calm: only big changes (cheaper). dense: small changes too (more frames, more tokens). game-economic: fast full-screen games only, far fewer frames. Sticky until changed; changing it restarts capture. Video files automatically use the dense cut threshold unless you set pace.'),
    scene: z.boolean().optional().describe('true = one full-size frame per image, one image per scene change; false = several frames packed per image (default). Sticky. Only use it when the user asks for scene-by-scene narration.'),
    seconds: z.number().optional().describe('With watch: upper bound of the blocking wait in seconds (default 300, max 860). It returns earlier as soon as a sheet is ready.'),
    minFrames: z.number().optional().describe('With watch: do not return an image with fewer frames than this (default 1). Ignored in scene mode.'),
    quality: z.string().optional().describe('"low" (default) | "standard" | "high" | "ultra". See the tool description for sizes and token costs. Changing it restarts capture and returns one frame of the current screen right away.'),
  };

  /** 路由本体（步骤 1-4）。抛出的异常由外层统一兜成错误结果。 */
  async function route(args = {}, extra = {}) {
    const action = String(args.action ?? 'watch').toLowerCase();

    // 模式开关（粘性）：变了必须拆管线重开 —— maxFrames/strategy 是建管线时定死的。
    if (typeof args.scene === 'boolean' && args.scene !== sceneMode) {
      sceneMode = args.scene;
      try { runner.stop(); } catch { /* 没在跑 */ }
      const note = sceneMode
        ? '已切到**逐帧模式**：每留下一个画面就单独给你一张满幅图（一张图 = 一个画面）。只在用户要求逐场景播报时用。'
        : '已切回**常规模式**：一张图装几帧、攒够才发。';
      pendingNote = [pendingNote, note].filter(Boolean).join('\n\n');
      log(note.replace(/\*\*/g, ''));
    }

    // 节奏（粘性）：出图频率和唤醒间隔由它定，口头答应"慢一点"不会改变行为。
    let wantPace = args.pace ? String(args.pace).toLowerCase() : null;
    // 旧名兼容：`action` 曾短暂用过，收到就走新档
    if (wantPace === 'action') wantPace = 'game-economic';
    if (wantPace && PACES[wantPace] && wantPace !== paceMode) {
      paceMode = wantPace;
      try { runner.stop(); } catch { /* 没在跑 */ }
      const t = {
        calm: '已切到**省电节奏**：20 分以上才算换画面。',
        normal: '已切回**默认节奏**：12 分算换画面。',
        dense: '已切到**灵敏节奏**：7 分就算换画面（费 token，只在演示/逐帧时用）。',
        'game-economic': '已切到**动作节奏**：80 分以上才算换画面，出帧按"攒够 30 秒运动量"算，每张图最多 8 帧（全屏游戏/高速画面用，信息量比 normal 少）。',
      }[wantPace];
      pendingNote = [t, pendingNote].filter(Boolean).join('\n\n');
      log(t.replace(/\*\*/g, ''));
    }

    if (action === 'watch') {
      /**
       * region 的三个入口，优先级从高到低：
       *   1. `region:"off"` —— 取消（存的那块一起删掉）
       *   2. `region:"x,y,w,h"` —— 这一次用这块（srcOf 负责校验和报错）
       *   3. 都没传 —— 用用户上次框好的那块
       */
      const rawRegion = typeof args.region === 'string' ? args.region.trim() : '';
      const regionOff = /^(off|none|clear)$/i.test(rawRegion);
      const built = srcOf(regionOff ? { ...args, region: undefined } : args);
      if (built.error) return errorResult(built.error);
      const src = built.src;
      const stickyRegion = regionOff ? null : (rawRegion ? undefined : loadRegion());
      if (regionOff) clearRegion();
      // 变了一次说一次：模型要知道自己现在只看这一块，也得知道已经回到整屏
      const regionKey = regionText(stickyRegion ?? src?.region ?? null);
      if (regionKey !== lastRegionKey) {
        lastRegionKey = regionKey;
        pendingNote = [
          regionKey
            ? `现在只抓屏幕上的 **${regionKey}** 这一块（屏幕物理像素）—— 画面之外的东西你看不到，`
              + '也不要假设整屏发生过什么。'
            : '已经回到**整屏**，不再只抓那一块。',
          pendingNote,
        ].filter(Boolean).join('\n\n');
      }
      const seconds = Math.min(
        Number(args.seconds) > 0 ? Number(args.seconds) : DEFAULT_BLOCK_SEC,
        MAX_BLOCK_SEC,
      );
      const requestedMinFrames = Number(args.minFrames) > 0 ? Number(args.minFrames) : 1;
      // 逐帧模式一张图只有 1 帧，minFrames > 1 永远等不满 —— 让它让路并说明。
      const minFrames = sceneMode ? 1 : requestedMinFrames;
      if (sceneMode && requestedMinFrames > 1) {
        pendingNote = [
          `逐帧模式下每张图只有 1 帧，\`minFrames: ${requestedMinFrames}\` 这条路上不生效（已按 1 处理）。`
          + '要按帧数攒图，先 `see_now({scene:false})`。',
          pendingNote,
        ].filter(Boolean).join('\n\n');
      }
      if (src?.kind) lastSrcKind = src.kind;
      const r = await runner.watch({
        seconds,
        minFrames,
        src,
        region: regionOff ? null : stickyRegion,
        quality: args.quality ? String(args.quality).toLowerCase() : null,
        opts: {
          ...(sceneMode ? SCENE_OPTS : {}),
          ...(sceneMode ? {} : (PACES[paceMode].pipeline ?? {})),
          // 文件回放走视频最优门槛（实测 cutAbs 7 比默认 12 的切点 F1 高约 5 个点）；
          // 用户显式传了 pace 就尊重用户。
          cutAbs: (sceneMode
            ? PACES.dense
            : (lastSrcKind === 'file' && !wantPace && paceMode === 'normal' ? PACES.dense : PACES[paceMode])).cutAbs,
        },
        signal: extra?.signal ?? null,
      });
      if (r.ok) return imageResult(r.sheet, { waited: r.waited, partial: r.partial });
      // 文件回放放完了：不能自动从头重播，必须显式再传一次来源。
      if (r.reason === 'file-ended') {
        return textResult(
          `这个文件已经放完了（${r.path ?? ''}）。\n`
          + '**不会自动重播**。要再看一遍就显式传 `source:"file"` + `path`，'
          + '要接着看屏幕就传 `source:"screen"`。',
        );
      }
      if (r.reason === 'cancelled') {
        return textResult('这一轮被取消了（调用被中止），等待已经结束。要接着看就再调 `see_now({action:"watch"})`。');
      }
      if (r.reason === 'no-change') {
        return textResult(
          `看了 ${r.waited.toFixed(0)} 秒，画面基本没变（不够 ${minFrames} 帧就不发）。`
          + '\n再等一会儿，或者直接问用户想让你看什么。',
        );
      }
      if (r.reason === 'busy') {
        return errorResult('另一个 watch 还在等，同一时刻只能有一个。等它返回再调。');
      }
      return errorResult(`没看成（${r.reason}）${r.error ? `：${r.error}` : ''}。`);
    }

    if (action === 'peek') {
      const s = runner.peek();
      if (!s) {
        return textResult(
          '手上还没有攒好的画面（刚开或刚取走，下一张还在攒）。要看此刻就调 `see_now({action:"watch"})`。',
        );
      }
      return imageResult(s);
    }

    if (action === 'start') {
      const built = srcOf(args);
      if (built.error) return errorResult(built.error);
      const r = await runner.start({ src: built.src ?? { kind: 'screen' } });
      return textResult(r.already ? '已经在看了。'
        : `开始看 ${r.source.kind}（引擎 ${r.engine}）${r.warning ? `。⚠️ ${r.warning}` : '。'}`);
    }

    if (action === 'stop') {
      runner.stop();
      return textResult('停了。想再看就再调 watch。');
    }

    if (action === 'status') {
      const s = runner.status();
      const cutAbs = (sceneMode ? PACES.dense : PACES[paceMode]).cutAbs;
      return textResult([
        (s.running
          ? `在看 ${s.source?.kind} @${s.size?.[0]}×${s.size?.[1]}（${s.quality}，${s.since}s，收到 ${s.frames} 帧，留帧 ${s.stats?.kept ?? 0}，出图 ${s.stats?.sheets ?? 0}）`
            + `${s.lastError ? `\n⚠ ${s.lastError}` : ''}`
          : `没在采集（${s.idleSec}s 前停的）${s.lastError ? `\n⚠ ${s.lastError}` : ''}`),
        `队列：${s.pending ? `有 ${s.pending} 张没取走（出图序号 ${s.sheets}）` : '空'}`,
        `模式：${sceneMode ? '逐帧（一张图 = 一个场景，铺满）' : '常规（多帧拼一张）'} · 节奏：${sceneMode ? 'dense（跟逐帧走）' : paceMode}（切点门槛 ${cutAbs}）`,
        `区域：${regionText(s.lastSource?.region ?? loadRegion()) ?? '整屏'}`,
      ].join('\n'));
    }

    if (action === 'region') {
      if (/^(off|none|clear)$/i.test(String(args.region ?? '').trim())) {
        const had = loadRegion();
        clearRegion();
        lastRegionKey = null;
        return textResult(had ? `已取消区域（原来是 ${regionText(had)}），下一次 watch 抓整屏。` : '本来就没设区域，现在还是整屏。');
      }
      const r = await pick({ log });
      if (!r.ok) {
        const why = {
          cancelled: '用户取消了框选（Esc / 右键），什么都没改。',
          timeout: '等了三分钟没框完，取框窗已经收掉了。',
          'no-python': `找不到能跑取框窗的 python（要带 tkinter）：${r.detail ?? ''}`,
          'no-script': `取框脚本不见了：${r.detail ?? ''}`,
          failed: `取框失败：${r.detail ?? ''}`,
        }[r.reason] ?? `取框没成（${r.reason}）。`;
        // 用户主动取消不算错误；真正的失败要 isError，否则模型会以为框好了。
        return r.reason === 'cancelled' ? textResult(why) : errorResult(why);
      }
      const t = regionText(r.region);
      lastRegionKey = t;
      pendingNote = `用户刚框好一块：**${t}**（屏幕物理像素）。现在只看这一块。`;
      log(`区域已选：${t}`);
      return textResult(
        `框好了：**${t}**（${r.region.w}×${r.region.h}，屏幕物理像素）。\n`
        + '从现在起 `watch` 默认只抓这块，不用再传 `region`。\n\n'
        + '三条你要知道的（也是该告诉用户的）：\n'
        + '- 抓的是**屏幕上正在显示的像素**：这块被别的窗口挡住，你看到的就是挡住它的那个窗口。\n'
        + '- 没接 OBS，抓不到后台窗口、最小化的窗口。\n'
        + '- 只在主屏有效；框到主屏外面会被拒绝（gdigrab 不接受负偏移）。\n'
        + '换一块：再调一次 `see_now({action:"region"})`；不要了：`see_now({action:"region", region:"off"})`。',
      );
    }

    return errorResult(`未知 action: ${action}（可用 watch / peek / start / stop / status / region）`);
  }

  server.registerTool('see_now', {
    title: 'See the screen now',
    description: TOOL_DESCRIPTION,
    inputSchema,
  }, async (args, extra) => {
    try {
      const out = await route(args ?? {}, extra ?? {});
      // 切换说明只带一次：下一次结果前的第一行，然后清掉。
      if (pendingNote) {
        const note = pendingNote;
        pendingNote = '';
        for (let i = out.content.length - 1; i >= 0; i -= 1) {
          if (out.content[i]?.type === 'text') {
            out.content[i].text = `${note}\n\n${out.content[i].text}`;
            break;
          }
        }
      }
      return out;
    } catch (e) {
      return errorResult(`see_now 出错：${e?.message ?? e}`);
    }
  });

  return server;
}

// 直接 `node src/mcp.js` 时才起 stdio 服务；被测试 import 时什么都不做。
if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  const log = (m) => process.stderr.write(`[see-now] ${m}\n`);
  const ffmpeg = resolveFfmpeg();
  log(`ffmpeg: ${ffmpeg.path}（${ffmpeg.source}）`);
  const runner = createRunner({ ffmpegPath: ffmpeg.path, log, headless: true });
  const server = createSeeNowServer({ runner, log });
  await server.connect(new StdioServerTransport());

  // 宿主关掉管道 / 进程被结束时把采集进程一起收掉，不留孤儿 ffmpeg。
  const shutdown = () => {
    try { runner.stop(); } catch { /* 已经停了 */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('close', shutdown);
}
