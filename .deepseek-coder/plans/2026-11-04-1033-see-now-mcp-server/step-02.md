# Step 02: Headless runner (no window, no window chat, no audio)

## Goal
`createRunner({ headless: true })` captures and packs sheets exactly as today, but never opens the floating
window, never reads or registers on the window chat channel, and never starts the audio listener.
`headless` defaults to `false`, and with `false` the behaviour stays exactly as it is now.

## Files to create or change
- Change `src/runner.js`
- Create `test/headless.test.mjs`

## Required interfaces (exact signatures, types, routes, schemas)
- `export function createRunner({ ffmpegPath = 'ffmpeg', log = () => {}, graceSec = 60, ctx = null, headless = false } = {})`
- When `headless` is true:
  1. **Listener:** do not call `createListener`. Use this stub instead:
     ```js
     {
       start: async () => ({ ok: false, reason: 'headless' }),
       stop: () => {},
       between: () => [],
       state: () => ({ enabled: false, reason: 'headless' }),
     }
     ```
  2. **Window chat:** do not call `chatWatcherShared()` (runner.js:208). Use `chatPoll = () => []`.
     In `watch()`, do not call `enterChatWait()` (runner.js:595). Use `leaveChan = () => {}`.
  3. **Window:** `ensureWindow()` (runner.js:382) sets `windowState = { ok: false, reason: 'headless' }` and
     returns it without calling `openWindow` or `setWindowHidden`. `windowOpened` stays `false`.
     `peek()` (runner.js:686) does not call `ensureWindow()` when headless.
  4. **Status:** `status()` gets a new field `headless` (boolean, the value passed to createRunner), for
     both headless and non-headless runners.
- With `headless: false` or omitted, every code path is the same as before this step.

## Constraints (style, libraries to use or avoid)
- No new dependencies. Match the file's style. Add a short Chinese comment at the `headless` parameter
  explaining that it is for the MCP server, where there is no floating window or audio.
- Keep the change local to `createRunner`. Do not restructure the rest of the file.

## Acceptance criteria
- The diff only touches `src/runner.js` and adds `test/headless.test.mjs`.
- `test/headless.test.mjs` (node:test + node:assert/strict) covers:
  1. (no ffmpeg needed) `createRunner({ headless: true }).status()` has `headless === true`,
     `listen.enabled === false`, `listen.reason === 'headless'`.
  2. (no ffmpeg needed) `createRunner().status().headless === false`.
  3. (skip when `ffmpeg -version` fails, same check as test/peek-minframes.test.mjs) Set
     `process.env.SEE_NOW_HOME` to a fresh mkdtemp dir **before** importing src/runner.js, and do **not**
     set `DSH_SEE_NO_WINDOW`. Generate a fixture `.tmp/headless-clip.mp4` with ffmpeg
     (`-f lavfi -i testsrc2=size=640x480:rate=12 -t 10`, libx264 ultrafast, yuv420p), the same way
     test/peek-minframes.test.mjs does. Call
     `runner.watch({ src: { kind: 'file', path: <fixture> }, seconds: 20 })` on a headless runner. Assert:
     `ok === true`, `status().window.reason === 'headless'`, `status().windowOpened === false`, and no file
     `see-now-window.pid` exists in the temp home dir. Call `runner.stop()` at the end (in `finally`).
- `npm test` passes with 0 failures.

## Verify with (only commands from allowedCommands)
- `npm test`

## Out of scope
- Do not touch src/index.js, src/window.js, src/listen.js, src/chat.js, src/loop.js or any other src file.
- No MCP code, no package.json changes.
- Do not edit existing tests.
