import fs from 'node:fs'
import path from 'node:path'
import { cleanUrl, withTrailingSlash } from '../shared/utils'
import type { ResolvedConfig } from './config'
import {
  ERR_SYMLINK_IN_RECURSIVE_READDIR,
  normalizePath,
  recursiveReaddir,
} from './utils'

//// 缓存publicFiles
const publicFilesMap = new WeakMap<ResolvedConfig, Set<string>>()

//// 初始化public目录
export async function initPublicFiles(
  config: ResolvedConfig,
): Promise<Set<string> | undefined> {
  let fileNames: string[]

  try {
    //// 读取文件路径，感觉可以用fse
    fileNames = await recursiveReaddir(config.publicDir)
  } catch (e) {
    //// 忽略符号链接错误问题，报错又忽略？
    if (e.code === ERR_SYMLINK_IN_RECURSIVE_READDIR) {
      return
    }

    throw e
  }

  //// 保留去重的相对路径
  const publicFiles = new Set(
    fileNames.map((fileName) => fileName.slice(config.publicDir.length)),
  )

  //// 缓存publicFiles
  publicFilesMap.set(config, publicFiles)

  return publicFiles
}

//// 获取publicFiles
function getPublicFiles(config: ResolvedConfig): Set<string> | undefined {
  return publicFilesMap.get(config)
}

export function checkPublicFile(
  url: string,
  config: ResolvedConfig,
): string | undefined {
  // note if the file is in /public, the resolver would have returned it
  // as-is so it's not going to be a fully resolved path.
  const { publicDir } = config
  if (!publicDir || url[0] !== '/') {
    return
  }

  const fileName = cleanUrl(url)

  // short-circuit if we have an in-memory publicFiles cache
  const publicFiles = getPublicFiles(config)
  if (publicFiles) {
    return publicFiles.has(fileName)
      ? normalizePath(path.join(publicDir, fileName))
      : undefined
  }

  const publicFile = normalizePath(path.join(publicDir, fileName))
  if (!publicFile.startsWith(withTrailingSlash(publicDir))) {
    // can happen if URL starts with '../'
    return
  }

  return fs.existsSync(publicFile) ? publicFile : undefined
}
