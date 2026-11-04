# Step 03: MCP server (src/mcp.js)

## Goal
A stdio MCP server that exposes one tool, `see_now`, to Claude Code. It drives a headless runner and returns
each packed sheet as an MCP image block (base64 PNG) plus a text block. Routing is ported and trimmed from
src/index.js; index.js itself stays unchanged.

## Files to create or change
- Run `npm install @modelcontextprotocol/sdk@1.32.2 zod@4` (adds both to `dependencies` in package.json and
  writes package-lock.json).
- Change `package.json`: add `"mcp": "node src/mcp.js"` to `scripts`; add `"./mcp": "./src/mcp.js"` to `exports`.
- Create `src/mcp.js`
- Create `test/mcp.test.mjs`

## Required interfaces (exact signatures, types, routes, schemas)

### Imports used by src/mcp.js
- `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`
- `import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';`
- `import { z } from 'zod';`
- From the project: `createRunner, SCENE_OPTS, PACES, DEFAULT_PACE` (runner.js), `resolveFfmpeg` (binaries.js),
  `parseRegion` (layout.js), `DEFAULT_BLOCK_SEC, TOOL_TIMEOUT_MS` (tool-spec.js),
  `pickRegion, loadRegion, clearRegion, regionText` (region.js).
- Do NOT import index.js, loop.js, chat.js, interject.js, voice.js, speech.js, window.js or listen.js.

### Exports
```js
/**
 * @param {{ runner: object, log?: (m: string) => void, pickRegion?: typeof pickRegion }} o
 * @returns {McpServer}  not yet connected to a transport
 */
export function createSeeNowServer({ runner, log = () => {}, pickRegion: pick = pickRegion } = {})
```
- `new McpServer({ name: 'see-now', version: VERSION })`. VERSION is read from ../package.json the same way
  index.js:74-76 does (fallback `'?'`).
- `MAX_BLOCK_SEC = Math.max(30, Math.floor(TOOL_TIMEOUT_MS / 1000) - 40)` (= 860), as index.js:71.
- Registers exactly one tool with `server.registerTool('see_now', { title: 'See the screen now', description, inputSchema }, handler)`.

### inputSchema (zod raw shape, every field optional, each with `.describe(<text below>)`)
| key | zod | describe text |
|---|---|---|
| action | `z.string().optional()` | `watch (default) \| peek \| start \| stop \| status \| region` |
| source | `z.string().optional()` | `"screen" (whole desktop, default), "obs" (OBS virtual camera), "camera" (first webcam), or "file" together with path to replay a local video. Only matters when capture starts.` |
| path | `z.string().optional()` | `With source:"file": absolute path of the video.` |
| realtime | `z.boolean().optional()` | `With source:"file": replay at 1x speed instead of as fast as ffmpeg can decode.` |
| region | `z.string().optional()` | `Capture only a rectangle of the primary screen, "x,y,w,h" in physical pixels. Usually not needed: use action:"region" to let the user drag one; it is saved and used by later watch calls. "off" goes back to the full screen. Only what is visible on screen is captured (covered or minimized windows are not). Costs more tokens than full screen because frames are not shrunk.` |
| pace | `z.string().optional()` | `"calm" \| "normal" (default) \| "dense" \| "game-economic". How big a change counts as a new frame. calm: only big changes (cheaper). dense: small changes too (more frames, more tokens). game-economic: fast full-screen games only, far fewer frames. Sticky until changed; changing it restarts capture. Video files automatically use the dense cut threshold unless you set pace.` |
| scene | `z.boolean().optional()` | `true = one full-size frame per image, one image per scene change; false = several frames packed per image (default). Sticky. Only use it when the user asks for scene-by-scene narration.` |
| seconds | `z.number().optional()` | `With watch: upper bound of the blocking wait in seconds (default 300, max 860). It returns earlier as soon as a sheet is ready.` |
| minFrames | `z.number().optional()` | `With watch: do not return an image with fewer frames than this (default 1). Ignored in scene mode.` |
| quality | `z.string().optional()` | `"low" (default) \| "standard" \| "high" \| "ultra". See the tool description for sizes and token costs. Changing it restarts capture and returns one frame of the current screen right away.` |

### Tool description (exact text)
```
Watch the user's screen live (or replay a local video file) and get back one PNG image made of several frames. Frames are kept only when the picture changes, so a static screen costs almost nothing and a busy one gives more frames. Frames are numbered 1..n in time order; the text lists each frame's timestamp and pixel size. Result text is in Chinese.

Actions:
- watch (default): blocking. The first call returns the current screen within about a second. Later calls block until a sheet is ready (usually 15-40 s while the screen changes, up to `seconds` when it is static), then return it. To keep watching, call watch again after you reply. There is no background wake-up: if you stop calling, you see nothing new.
- peek: return a sheet that has already piled up, without waiting. Returns a short note if none is ready.
- start: begin capturing without waiting for an image. stop: stop capturing.
- status: whether capture is running, frames kept, queue, mode, pace and region.
- region: show a dim full-screen overlay so the user can drag a rectangle; later watch calls capture only that rectangle. region:"off" goes back to the full screen. Blocks until the user finishes (up to 3 minutes), so tell the user what to do before calling it.

Cost (Claude vision tokens per image): quality "low" 800x450 about 493, "standard" 1066x600 about 858, "high" 1280x720 about 1196, "ultra" 1600x900 about 1914. Do not poll faster than about every 10 seconds. If you cannot read something (small text, filenames), do not guess: call watch with quality:"high". Changing quality restarts capture and immediately returns one sharp frame of the current screen.
```

### Handler state (closure of createSeeNowServer)
`sceneMode = false`, `paceMode = DEFAULT_PACE`, `lastSrcKind = null`, `pendingNote = ''`,
`lastRegionKey = regionText(loadRegion())`.

### Handler `async (args, extra) => CallToolResult`
Result shapes:
- text result: `{ content: [{ type: 'text', text }] }`
- error result: `{ content: [{ type: 'text', text }], isError: true }`
- image result: `{ content: [{ type: 'image', data: sheet.png.toString('base64'), mimeType: 'image/png' }, { type: 'text', text }] }`

Steps, in order:
1. `action = String(args.action ?? 'watch').toLowerCase()`.
2. **scene** (port of index.js:518-529): if `typeof args.scene === 'boolean' && args.scene !== sceneMode`: set it,
   `runner.stop()` (in try/catch), and append to pendingNote:
   on: `已切到**逐帧模式**：每留下一个画面就单独给你一张满幅图（一张图 = 一个画面）。只在用户要求逐场景播报时用。`
   off: `已切回**常规模式**：一张图装几帧、攒够才发。`
3. **pace** (port of index.js:537-554): `wantPace = args.pace ? String(args.pace).toLowerCase() : null`;
   `'action'` maps to `'game-economic'`. If `PACES[wantPace]` exists and differs from paceMode: set it,
   `runner.stop()` (try/catch), prepend the note for that pace to pendingNote:
   - calm: `已切到**省电节奏**：20 分以上才算换画面。`
   - normal: `已切回**默认节奏**：12 分算换画面。`
   - dense: `已切到**灵敏节奏**：7 分就算换画面（费 token，只在演示/逐帧时用）。`
   - game-economic: `已切到**动作节奏**：80 分以上才算换画面，出帧按"攒够 30 秒运动量"算，每张图最多 8 帧（全屏游戏/高速画面用，信息量比 normal 少）。`
   Notes are joined with `\n\n` (same as index.js).
4. Route by action:
   - **watch**: port index.js:571-631 exactly (srcOf, `region:"off"`/sticky region handling and its notes,
     seconds = min(args.seconds > 0 ? args.seconds : DEFAULT_BLOCK_SEC, MAX_BLOCK_SEC), minFrames with the scene
     note, `lastSrcKind`, the `opts` object with SCENE_OPTS / PACES pipeline / cutAbs rule), with
     `signal: extra?.signal ?? null`. Port `srcOf` from index.js:35-60 into mcp.js unchanged.
     - `srcOf` error -> **error result** with that text; `runner.watch` is not called.
     - `r.ok` -> **image result** with `sheetText(r.sheet, { waited: r.waited, partial: r.partial })`.
     - `r.reason === 'file-ended'` -> text result, text as index.js:645-647.
     - `r.reason === 'cancelled'` -> text result: `这一轮被取消了（调用被中止），等待已经结束。要接着看就再调 \`see_now({action:"watch"})\`。`
     - `r.reason === 'no-change'` -> text result, text as index.js:667-668.
     - `r.reason === 'busy'` -> **error result**: `另一个 watch 还在等，同一时刻只能有一个。等它返回再调。`
     - any other reason -> **error result**: `` `没看成（${r.reason}）${r.error ? `：${r.error}` : ''}。` ``
   - **peek**: `s = runner.peek()`. null -> text result
     `手上还没有攒好的画面（刚开或刚取走，下一张还在攒）。要看此刻就调 \`see_now({action:"watch"})\`。`;
     otherwise image result with `sheetText(s)`.
   - **start**: as index.js:724-733 (srcOf error -> error result; text as index.js:729-730).
   - **stop**: `runner.stop()`; text result `停了。想再看就再调 watch。`
   - **status**: text result, lines joined with `\n`:
     1. capture line, as index.js:859-862;
     2. `队列：` line as index.js:866;
     3. `` `模式：${sceneMode ? '逐帧（一张图 = 一个场景，铺满）' : '常规（多帧拼一张）'} · 节奏：${sceneMode ? 'dense（跟逐帧走）' : paceMode}（切点门槛 ${cutAbs}）` `` where cutAbs is `(sceneMode ? PACES.dense : PACES[paceMode]).cutAbs`;
     4. `区域：` line as index.js:876.
   - **region**: port index.js:786-819 using `pick({ log })` instead of `pickRegion`; failure -> **error result**
     except `cancelled`, which is a text result. Success and `off` are text results with the same texts.
   - anything else -> **error result** `` `未知 action: ${action}（可用 watch / peek / start / stop / status / region）` ``
5. If pendingNote is non-empty, prepend `${pendingNote}\n\n` to the text block of whatever result is returned
   (the last text item of `content`), then set pendingNote = ''.
6. Any exception thrown in steps 1-5 -> **error result** `` `see_now 出错：${e?.message ?? e}` ``.

### sheetText (in mcp.js)
`function sheetText(sheet, { waited = 0, partial = false } = {})`: same `span`, `head`, per-frame `lines` and
`whyText` as index.js:144-169, returning
`` `${head}\n${lines.join('\n')}\n（${whyText}；想看下一段就再调一次 \`see_now({action:"watch"})\`。）` ``.
No transcript, interject, lastSaid, loop or reply-reminder parts.

### Entry point (bottom of src/mcp.js)
Runs only when executed directly:
`process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()`.
Then:
1. `log = (m) => process.stderr.write(\`[see-now] ${m}\n\`)`.
2. `ffmpeg = resolveFfmpeg()`; `log(\`ffmpeg: ${ffmpeg.path}（${ffmpeg.source}）\`)`.
3. `runner = createRunner({ ffmpegPath: ffmpeg.path, log, headless: true })`.
4. `server = createSeeNowServer({ runner, log })`; `await server.connect(new StdioServerTransport())`.
5. On `SIGINT`, `SIGTERM` and `process.stdin` `'close'`: `runner.stop()` (try/catch) then `process.exit(0)`.

## Constraints (style, libraries to use or avoid)
- Nothing in src/mcp.js may write to stdout (stdout is the MCP channel). All logging goes to stderr through `log`.
- ESM, Node >= 20. Only the two new dependencies. Match the codebase style; Chinese comments where they
  explain why.
- Do not change src/index.js, src/runner.js or any other existing src file.

## Acceptance criteria
- package.json `dependencies` has `@modelcontextprotocol/sdk` 1.32.2 and `zod` ^4; `scripts.mcp` and `exports["./mcp"]` exist.
- src/mcp.js exports `createSeeNowServer` as specified and has the entry point as specified.
- `test/mcp.test.mjs` sets `process.env.SEE_NOW_HOME` to a fresh mkdtemp dir before importing src/mcp.js,
  connects a `Client` (`@modelcontextprotocol/sdk/client/index.js`) to the server through
  `InMemoryTransport.createLinkedPair()` (`@modelcontextprotocol/sdk/inMemory.js`), and uses a fake runner
  that records calls (`watch`, `peek`, `start`, `stop`, `status`) and returns scripted values. Fake sheet:
  `{ png: Buffer.from('fakepng'), frames: [{ t: 1, tier: 2, via: 'cut' }, { t: 3, tier: 2, via: 'cut' }], from: 1, to: 3, fill: 0.5, why: 'full', w: 800, h: 450, cells: [{ pw: 400, ph: 225 }, { pw: 400, ph: 225 }] }`.
  Fake status: `{ running: false, idleSec: 0, lastError: null, pending: 0, sheets: 0, lastSource: null, headless: true }`.
  Tests:
  1. listTools returns one tool `see_now` whose inputSchema properties are exactly
     action, source, path, realtime, region, pace, scene, seconds, minFrames, quality.
  2. watch ok -> content[0] is `{ type: 'image', mimeType: 'image/png', data: Buffer.from('fakepng').toString('base64') }`,
     content[1] is text containing `2 个画面`; isError is falsy.
  3. watch with `seconds: 5000` -> fake runner.watch received `seconds: 860`; without seconds -> `300`;
     received `signal` is an `AbortSignal`.
  4. watch returning `{ ok: false, reason: 'no-change', waited: 30 }` -> isError falsy, text contains `画面基本没变`.
  5. watch with `region: 'abc'` -> isError true, fake runner.watch not called.
  6. watch returning `{ ok: false, reason: 'capture-stopped', waited: 1, error: 'x' }` -> isError true.
  7. `pace: 'calm'` -> runner.stop called once, the result text starts with `已切到**省电节奏**`;
     the next call's text does not contain `省电节奏`.
  8. peek returning null -> isError falsy, text contains `还没有攒好`; peek returning the fake sheet -> image result.
  9. `action: 'fly'` -> isError true.
  10. status -> isError falsy, text contains `模式：`.
  11. `action: 'region', region: 'off'` -> isError falsy, text contains `整屏`.
- `npm test` passes with 0 failures.

## Verify with (only commands from allowedCommands)
- `npm test`

## Out of scope
- Do not modify src/index.js, src/runner.js, src/tool-spec.js, README or any existing test.
- No floating window, `say`, audio, wake loop or `window` action.
- Do not register the server with Claude Code (the planner does that after the run).
