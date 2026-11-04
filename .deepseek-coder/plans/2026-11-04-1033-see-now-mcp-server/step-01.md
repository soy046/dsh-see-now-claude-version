# Step 01: Shared home-dir helper (SEE_NOW_HOME)

## Goal
Every module resolves the see-now config/data directory through one function, with the precedence
SEE_NOW_HOME > DSH_HOME > (USERPROFILE || HOME || os.homedir())/.dsh.

## Files to create or change
- Create `src/home.js`
- Change `src/chat.js` (function `dshHome`, line 21-23)
- Change `src/binaries.js` (line 34)
- Change `src/voice.js` (lines 48, 69, 202)
- Change `src/listen.js` (local function `dshHome`, lines 110-112)
- Create `test/home.test.mjs`

## Required interfaces (exact signatures, types, routes, schemas)
`src/home.js`:
```js
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function seeNowHome(env = process.env) {
  return env.SEE_NOW_HOME || env.DSH_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.dsh');
}
```
- `src/chat.js`: keep the exported name `dshHome(env = process.env)` (window.js and region.js import it); its body becomes `return seeNowHome(env);`.
- `src/binaries.js` line 34: `const home = seeNowHome(env);`
- `src/voice.js` lines 48, 69, 202: `const home = seeNowHome(env);`
- `src/listen.js`: the local `dshHome(env)` body becomes `return seeNowHome(env);` (keep the local function name so its call sites stay the same).
- Remove `homedir` imports from files where it is no longer used.

## Constraints (style, libraries to use or avoid)
- ESM, Node >= 20, no new dependencies.
- Match the surrounding style: 2-space indent, single quotes, semicolons. Add a short Chinese JSDoc comment to `seeNowHome` explaining the precedence, like the rest of the codebase.
- Do not change any other behaviour.

## Acceptance criteria
- `src/home.js` exists and exports `seeNowHome` exactly as above.
- No file in `src/` other than `src/home.js` computes `join(..., '.dsh')` from `homedir()`/`USERPROFILE`/`HOME`, or reads `env.DSH_HOME` directly.
- `test/home.test.mjs` (node:test + node:assert/strict) covers:
  1. SEE_NOW_HOME set (and DSH_HOME set too) -> returns SEE_NOW_HOME.
  2. Only DSH_HOME set -> returns DSH_HOME.
  3. Neither set, USERPROFILE set -> returns join(USERPROFILE, '.dsh').
  4. Neither set, no USERPROFILE, HOME set -> returns join(HOME, '.dsh').
  5. `chatDir({ SEE_NOW_HOME: X })` from src/chat.js returns join(X, 'see-now').
  6. `resolveFfmpeg({ env: { SEE_NOW_HOME: tmp }, platform: 'win32' })` returns the path join(tmp, 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe') when that file exists (create it in an mkdtemp dir).
  Tests pass env objects explicitly; they must not modify process.env.
- `npm test` passes with 0 failures.

## Verify with (only commands from allowedCommands)
- `npm test`

## Out of scope
- Do not touch `src/index.js`, `src/runner.js`, `src/window.js`, `src/region.js` (they already go through `chat.js` `dshHome`).
- Do not add src/mcp.js or any MCP code. Do not change package.json.
- Do not edit existing tests.
