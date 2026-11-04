/**
 * home.js — see-now 的配置/数据目录，只在这一个地方算。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 配置/数据根目录。优先级 `SEE_NOW_HOME` > `DSH_HOME` >
 * `(USERPROFILE || HOME || os.homedir())/.dsh`：独立测试时用 `SEE_NOW_HOME`
 * 把整棵树换掉，不去碰用户的真实 `~/.dsh`。
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function seeNowHome(env = process.env) {
  return env.SEE_NOW_HOME || env.DSH_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.dsh');
}
