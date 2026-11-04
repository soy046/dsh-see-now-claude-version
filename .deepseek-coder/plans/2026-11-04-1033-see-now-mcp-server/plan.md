# Plan: Port see_now to a Claude Code MCP server

## Decisions
- Audio (listen.js) in v1? -> No, skip audio in v1.
- Who writes the code? -> DeepSeek via the deepseek-coder plugin; Claude plans and reviews.
- Keep edits to existing files minimal for upstream merges? -> No. The fork never merges back; refactor freely.
- Image size cap? -> No extra cap (Opus 5.5 accepts up to 2576 px long edge; see-now stays below that). Fix the token numbers in the description.
- Floating window in MCP mode? -> Disabled. No `window` action, no `say` param.
- Config dir env var? -> SEE_NOW_HOME > DSH_HOME > (USERPROFILE || HOME || homedir())/.dsh, through one shared helper src/home.js used by every module.
- Which params does MCP see_now keep? -> All except `say`: action, source, path, realtime, region, pace, scene, seconds, minFrames, quality. Actions: watch, peek, start, stop, status, region.
- SDK style? -> McpServer + zod (registerTool with a zod raw shape).
- Tool text? -> New English tool description (no say/window/loop, correct Claude token costs). Per-sheet result text stays Chinese, as in index.js, minus the say/loop/window parts.
- Tests for MCP server? -> mcp.js exports createSeeNowServer({runner}); test/mcp.test.mjs drives it through the SDK's InMemoryTransport with a fake runner.
- ffmpeg? -> Claude runs `winget install Gyan.FFmpeg` (done: 9.0.2, C:\Users\USER\AppData\Local\Microsoft\WinGet\Links\ffmpeg.exe).
- How does runner disable window/chat/audio? -> One flag: createRunner({headless:true}). Default false keeps DSH behaviour unchanged.
- Reuse of index.js routing? -> Standalone mcp.js with its own trimmed routing ported from index.js; index.js keeps working for DSH.
- Errors? -> isError:true only for real failures (bad region, capture failure, unknown action). no-change, file-ended, cancelled, no-sheet are normal text results.
- Registration scope? -> User scope: `claude mcp add -s user see-now -- node D:/projects/dsh-see-now-claude-version/src/mcp.js`.
- deepseek-coder config -> approved as written; pricing CNY peak rate (2 / 0.04 / 8 per 1M tokens, api-docs.deepseek.com/zh-cn/quick_start/pricing).

## Confirmed facts
- Home dir is computed inline in 6 places: binaries.js:34, chat.js:22 (`dshHome`, exported and used by window.js and region.js), voice.js:48, voice.js:69, voice.js:202, listen.js:111 (local `dshHome`). (source: grep)
- runner.watch() always opens the floating window (runner.js:559), starts the listener (runner.js:363), polls window chat (runner.js:208, 567, 595). peek() opens the window too (runner.js:686).
- index.js routing: srcOf() (index.js:35), sheetText() (index.js:144), watch routing (index.js:556-706), MAX_BLOCK_SEC = 860 (index.js:71, TOOL_TIMEOUT_MS 900000 in tool-spec.js).
- The wake loop (loop.js) needs DSH's sessionController; an MCP server cannot wake the model.
- @modelcontextprotocol/sdk 1.32.2: McpServer.registerTool inputSchema accepts only zod schemas (server/zod-compat.d.ts: AnySchema = z3.ZodTypeAny | z4.$ZodType); zod is a peer dependency.
- Claude Code MCP: default tool timeout about 28 hours; image results shown inline (code.claude.com/docs/en/mcp).
- Opus 5.5 image cost = ceil(w/28) x ceil(h/28); max 2576 px long edge (platform.claude.com/docs/en/build-with-claude/vision). low 800x450 = 493, standard 1066x600 = 858, high 1280x720 = 1196, ultra 1600x900 = 1914 tokens.
- Baseline `npm test` with ffmpeg on PATH: 158 tests, 145 pass, 13 skipped, 0 fail.

## Steps
1. Shared home helper: add src/home.js (seeNowHome) and route all 6 home computations through it, with tests.
2. Headless runner: createRunner({headless:true}) skips window, window chat and audio, with tests.
3. MCP server: add src/mcp.js (McpServer + zod, stdio), deps, package.json script/export, and test/mcp.test.mjs with a fake runner.
