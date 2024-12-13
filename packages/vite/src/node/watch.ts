import { EventEmitter } from 'node:events'
import path from 'node:path'
import type { FSWatcher, WatchOptions } from 'dep-types/chokidar'
import type { OutputOptions } from 'rollup'
import colors from 'picocolors'
import { escapePath } from 'tinyglobby'
import { withTrailingSlash } from '../shared/utils'
import { arraify, normalizePath } from './utils'
import type { Logger } from './logger'

export function getResolvedOutDirs(
  root: string,
  outDir: string,
  outputOptions: OutputOptions[] | OutputOptions | undefined,
): Set<string> {
  //// 绝对路径
  const resolvedOutDir = path.resolve(root, outDir)

  ////  没有rollup配置则直接返回
  if (!outputOptions) return new Set([resolvedOutDir])

  //// 优先使用rollup配置
  return new Set(
    arraify(outputOptions).map(({ dir }) =>
      dir ? path.resolve(root, dir) : resolvedOutDir,
    ),
  )
}

export function resolveEmptyOutDir(
  emptyOutDir: boolean | null,
  root: string,
  outDirs: Set<string>,
  logger?: Logger,
): boolean {
  if (emptyOutDir != null) return emptyOutDir

  //// 若 outDir 在根目录之外则会抛出一个警告避免意外删除掉重要的文件
  for (const outDir of outDirs) {
    if (!normalizePath(outDir).startsWith(withTrailingSlash(root))) {
      // warn if outDir is outside of root
      logger?.warn(
        colors.yellow(
          `\n${colors.bold(`(!)`)} outDir ${colors.white(
            colors.dim(outDir),
          )} is not inside project root and will not be emptied.\n` +
            `Use --emptyOutDir to override.\n`,
        ),
      )
      return false
    }
  }
  return true
}

export function resolveChokidarOptions(
  options: WatchOptions | undefined,
  resolvedOutDirs: Set<string>,
  emptyOutDir: boolean,
  cacheDir: string,
): WatchOptions {
  const { ignored: ignoredList, ...otherOptions } = options ?? {}

  //// 忽略的路径
  const ignored: WatchOptions['ignored'] = [
    '**/.git/**',
    '**/node_modules/**',
    '**/test-results/**', // Playwright
    escapePath(cacheDir) + '/**',
    ...arraify(ignoredList || []),
  ]

  //// clean产物时也忽略产物文件夹
  if (emptyOutDir) {
    ignored.push(
      ...[...resolvedOutDirs].map((outDir) => escapePath(outDir) + '/**'),
    )
  }

  const resolvedWatchOptions: WatchOptions = {
    ignored,
    ignoreInitial: true,
    ignorePermissionErrors: true,
    ...otherOptions,
  }

  return resolvedWatchOptions
}

class NoopWatcher extends EventEmitter implements FSWatcher {
  constructor(public options: WatchOptions) {
    super()
  }

  add() {
    return this
  }

  unwatch() {
    return this
  }

  getWatched() {
    return {}
  }

  ref() {
    return this
  }

  unref() {
    return this
  }

  async close() {
    // noop
  }
}

export function createNoopWatcher(options: WatchOptions): FSWatcher {
  return new NoopWatcher(options)
}
