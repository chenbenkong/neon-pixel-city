/**
 * edge-profile.mjs —— Edge 无头测试的浏览器 profile 目录管理
 *
 * ## 为什么要这个文件
 *
 * 过去 19 个 QA 脚本各自用 `join(__dirname, '.edge-xxx' + Date.now())` 启动 Edge，
 * 其中 11 个带 `Date.now()`，于是**每跑一次就在仓库里新建一个约 48MB 的浏览器配置目录，
 * 而且从不清理**。13 次跑测堆出 732MB；其中一次还被 `git add -A` 误提交进版本库
 * （2121 文件 / 8.7 万行，含浏览器扩展二进制），最终需要重写 git 历史才清掉。
 *
 * 根因不是"忘了删"，而是**profile 目录本来就该放在仓库外**——
 * 它是可再生的一次性产物，不是源码、不是测试资产。
 *
 * ## 现在的做法
 *
 * - 统一放系统临时目录，仓库里不再产生任何 profile
 * - **固定名字复用**，不按时间戳新建，所以重复跑测不会累积
 * - 需要隔离时用 `edgeProfile('tag')` 给不同脚本不同目录，避免并发跑测互相污染
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'neon-pixel-city-qa-edge';

/**
 * 取一个稳定的 profile 路径。
 * @param {string} [tag] 脚本标识。同一 tag 复用同一目录；不传则用通用目录。
 */
export function edgeProfile(tag) {
  return join(tmpdir(), tag ? `${BASE}-${tag}` : BASE);
}

/** 供需要自己拼路径的脚本使用：临时目录根。 */
export const PROFILE_ROOT = tmpdir();
