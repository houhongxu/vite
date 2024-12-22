import path from 'node:path'
import type * as net from 'node:net'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import type * as http from 'node:http'
import { performance } from 'node:perf_hooks'
import type { Http2SecureServer } from 'node:http2'
import connect from 'connect'
import corsMiddleware from 'cors'
import colors from 'picocolors'
import chokidar from 'chokidar'
import type { FSWatcher, WatchOptions } from 'dep-types/chokidar'
import type { Connect } from 'dep-types/connect'
import launchEditorMiddleware from 'launch-editor-middleware'
import type { SourceMap } from 'rollup'
import picomatch from 'picomatch'
import type { Matcher } from 'picomatch'
import type { InvalidatePayload } from 'types/customEvent'
import type { CommonServerOptions } from '../http'
import {
  httpServerStart,
  resolveHttpServer,
  resolveHttpsConfig,
  setClientErrorHandler,
} from '../http'
import type { InlineConfig, ResolvedConfig } from '../config'
import { isDepsOptimizerEnabled, resolveConfig } from '../config'
import {
  diffDnsOrderChange,
  isInNodeModules,
  isObject,
  isParentDirectory,
  mergeConfig,
  normalizePath,
  resolveHostname,
  resolveServerUrls,
} from '../utils'
import { ssrLoadModule } from '../ssr/ssrModuleLoader'
import { ssrFixStacktrace, ssrRewriteStacktrace } from '../ssr/ssrStacktrace'
import { ssrTransform } from '../ssr/ssrTransform'
import { ERR_OUTDATED_OPTIMIZED_DEP } from '../plugins/optimizedDeps'
import {
  getDepsOptimizer,
  initDepsOptimizer,
  initDevSsrDepsOptimizer,
} from '../optimizer'
import { bindCLIShortcuts } from '../shortcuts'
import type { BindCLIShortcutsOptions } from '../shortcuts'
import { CLIENT_DIR, DEFAULT_DEV_PORT } from '../constants'
import type { Logger } from '../logger'
import { printServerUrls } from '../logger'
import { createNoopWatcher, resolveChokidarOptions } from '../watch'
import type { PluginContainer } from './pluginContainer'
import { ERR_CLOSED_SERVER, createPluginContainer } from './pluginContainer'
import type { WebSocketServer } from './ws'
import { createWebSocketServer } from './ws'
import { baseMiddleware } from './middlewares/base'
import { proxyMiddleware } from './middlewares/proxy'
import { htmlFallbackMiddleware } from './middlewares/htmlFallback'
import { transformMiddleware } from './middlewares/transform'
import {
  createDevHtmlTransformFn,
  indexHtmlMiddleware,
} from './middlewares/indexHtml'
import {
  servePublicMiddleware,
  serveRawFsMiddleware,
  serveStaticMiddleware,
} from './middlewares/static'
import { timeMiddleware } from './middlewares/time'
import type { ModuleNode } from './moduleGraph'
import { ModuleGraph } from './moduleGraph'
import { notFoundMiddleware } from './middlewares/notFound'
import { errorMiddleware, prepareError } from './middlewares/error'
import type { HmrOptions } from './hmr'
import {
  getShortName,
  handleFileAddUnlink,
  handleHMRUpdate,
  updateModules,
} from './hmr'
import { openBrowser as _openBrowser } from './openBrowser'
import type { TransformOptions, TransformResult } from './transformRequest'
import { transformRequest } from './transformRequest'
import { searchForWorkspaceRoot } from './searchRoot'
import { warmupFiles } from './warmup'

export interface ServerOptions extends CommonServerOptions {
  /**
   * Configure HMR-specific options (port, host, path & protocol)
   */
  hmr?: HmrOptions | boolean
  /**
   * Warm-up files to transform and cache the results in advance. This improves the
   * initial page load during server starts and prevents transform waterfalls.
   */
  warmup?: {
    /**
     * The files to be transformed and used on the client-side. Supports glob patterns.
     */
    clientFiles?: string[]
    /**
     * The files to be transformed and used in SSR. Supports glob patterns.
     */
    ssrFiles?: string[]
  }
  /**
   * chokidar watch options or null to disable FS watching
   * https://github.com/paulmillr/chokidar#api
   */
  watch?: WatchOptions | null
  /**
   * Create Vite dev server to be used as a middleware in an existing server
   * @default false
   */
  middlewareMode?:
    | boolean
    | {
        /**
         * Parent server instance to attach to
         *
         * This is needed to proxy WebSocket connections to the parent server.
         */
        server: http.Server
      }
  /**
   * Options for files served via '/\@fs/'.
   */
  fs?: FileSystemServeOptions
  /**
   * Origin for the generated asset URLs.
   *
   * @example `http://127.0.0.1:8080`
   */
  origin?: string
  /**
   * Pre-transform known direct imports
   * @default true
   */
  preTransformRequests?: boolean
  /**
   * Whether or not to ignore-list source files in the dev server sourcemap, used to populate
   * the [`x_google_ignoreList` source map extension](https://developer.chrome.com/blog/devtools-better-angular-debugging/#the-x_google_ignorelist-source-map-extension).
   *
   * By default, it excludes all paths containing `node_modules`. You can pass `false` to
   * disable this behavior, or, for full control, a function that takes the source path and
   * sourcemap path and returns whether to ignore the source path.
   */
  sourcemapIgnoreList?:
    | false
    | ((sourcePath: string, sourcemapPath: string) => boolean)
}

export interface ResolvedServerOptions extends ServerOptions {
  fs: Required<FileSystemServeOptions>
  middlewareMode: boolean
  sourcemapIgnoreList: Exclude<
    ServerOptions['sourcemapIgnoreList'],
    false | undefined
  >
}

export interface FileSystemServeOptions {
  /**
   * Strictly restrict file accessing outside of allowing paths.
   *
   * Set to `false` to disable the warning
   *
   * @default true
   */
  strict?: boolean

  /**
   * Restrict accessing files outside the allowed directories.
   *
   * Accepts absolute path or a path relative to project root.
   * Will try to search up for workspace root by default.
   */
  allow?: string[]

  /**
   * Restrict accessing files that matches the patterns.
   *
   * This will have higher priority than `allow`.
   * picomatch patterns are supported.
   *
   * @default ['.env', '.env.*', '*.crt', '*.pem']
   */
  deny?: string[]
}

export type ServerHook = (
  this: void,
  server: ViteDevServer,
) => (() => void) | void | Promise<(() => void) | void>

export type HttpServer = http.Server | Http2SecureServer

export interface ViteDevServer {
  /**
   * The resolved vite config object
   */
  config: ResolvedConfig
  /**
   * A connect app instance.
   * - Can be used to attach custom middlewares to the dev server.
   * - Can also be used as the handler function of a custom http server
   *   or as a middleware in any connect-style Node.js frameworks
   *
   * https://github.com/senchalabs/connect#use-middleware
   */
  middlewares: Connect.Server
  /**
   * native Node http server instance
   * will be null in middleware mode
   */
  httpServer: HttpServer | null
  /**
   * chokidar watcher instance
   * https://github.com/paulmillr/chokidar#api
   */
  watcher: FSWatcher
  /**
   * web socket server with `send(payload)` method
   */
  ws: WebSocketServer
  /**
   * Rollup plugin container that can run plugin hooks on a given file
   */
  pluginContainer: PluginContainer
  /**
   * Module graph that tracks the import relationships, url to file mapping
   * and hmr state.
   */
  moduleGraph: ModuleGraph
  /**
   * The resolved urls Vite prints on the CLI. null in middleware mode or
   * before `server.listen` is called.
   */
  resolvedUrls: ResolvedServerUrls | null
  /**
   * Programmatically resolve, load and transform a URL and get the result
   * without going through the http request pipeline.
   */
  transformRequest(
    url: string,
    options?: TransformOptions,
  ): Promise<TransformResult | null>
  /**
   * Same as `transformRequest` but only warm up the URLs so the next request
   * will already be cached. The function will never throw as it handles and
   * reports errors internally.
   */
  warmupRequest(url: string, options?: TransformOptions): Promise<void>
  /**
   * Apply vite built-in HTML transforms and any plugin HTML transforms.
   */
  transformIndexHtml(
    url: string,
    html: string,
    originalUrl?: string,
  ): Promise<string>
  /**
   * Transform module code into SSR format.
   */
  ssrTransform(
    code: string,
    inMap: SourceMap | { mappings: '' } | null,
    url: string,
    originalCode?: string,
  ): Promise<TransformResult | null>
  /**
   * Load a given URL as an instantiated module for SSR.
   */
  ssrLoadModule(
    url: string,
    opts?: { fixStacktrace?: boolean },
  ): Promise<Record<string, any>>
  /**
   * Returns a fixed version of the given stack
   */
  ssrRewriteStacktrace(stack: string): string
  /**
   * Mutates the given SSR error by rewriting the stacktrace
   */
  ssrFixStacktrace(e: Error): void
  /**
   * Triggers HMR for a module in the module graph. You can use the `server.moduleGraph`
   * API to retrieve the module to be reloaded. If `hmr` is false, this is a no-op.
   */
  reloadModule(module: ModuleNode): Promise<void>
  /**
   * Start the server.
   */
  listen(port?: number, isRestart?: boolean): Promise<ViteDevServer>
  /**
   * Stop the server.
   */
  close(): Promise<void>
  /**
   * Print server urls
   */
  printUrls(): void
  /**
   * Bind CLI shortcuts
   */
  bindCLIShortcuts(options?: BindCLIShortcutsOptions<ViteDevServer>): void
  /**
   * Restart the server.
   *
   * @param forceOptimize - force the optimizer to re-bundle, same as --force cli flag
   */
  restart(forceOptimize?: boolean): Promise<void>

  /**
   * Open browser
   */
  openBrowser(): void
  /**
   * @internal
   */
  _setInternalServer(server: ViteDevServer): void
  /**
   * @internal
   */
  _importGlobMap: Map<string, { affirmed: string[]; negated: string[] }[]>
  /**
   * @internal
   */
  _restartPromise: Promise<void> | null
  /**
   * @internal
   */
  _forceOptimizeOnRestart: boolean
  /**
   * @internal
   */
  _pendingRequests: Map<
    string,
    {
      request: Promise<TransformResult | null>
      timestamp: number
      abort: () => void
    }
  >
  /**
   * @internal
   */
  _fsDenyGlob: Matcher
  /**
   * @internal
   */
  _shortcutsOptions?: BindCLIShortcutsOptions<ViteDevServer>
  /**
   * @internal
   */
  _currentServerPort?: number | undefined
  /**
   * @internal
   */
  _configServerPort?: number | undefined
}

export interface ResolvedServerUrls {
  local: string[]
  network: string[]
}

//// 套一层默认参数
export function createServer(
  inlineConfig: InlineConfig = {},
): Promise<ViteDevServer> {
  return _createServer(inlineConfig, { ws: true })
}

export async function _createServer(
  inlineConfig: InlineConfig = {},
  options: { ws: boolean },
): Promise<ViteDevServer> {
  //// 解析并处理配置文件
  const config = await resolveConfig(inlineConfig, 'serve')

  //// root和server
  const { root, server: serverConfig } = config

  //// server.https https.createServer() 的 选项对象
  const httpsOptions = await resolveHttpsConfig(config.server.https)

  //// server.middlewareMode 默认false，true则将vite服务返回为中间件
  const { middlewareMode } = serverConfig

  //// 解析chokidar库配置
  const resolvedWatchOptions = resolveChokidarOptions(config, {
    disableGlobbing: true,
    ...serverConfig.watch,
  })

  //// 使用connect库中间件创建中间件
  const middlewares = connect() as Connect.Server

  //// 创建http服务器，middlewareMode开启则代表vite作为中间件，关闭则使用vite启动的http服务器
  const httpServer = middlewareMode
    ? null
    : await resolveHttpServer(serverConfig, middlewares, httpsOptions)

  //// 创建websocket服务器
  const ws = createWebSocketServer(httpServer, config, httpsOptions)

  //// 监听错误信息并处理
  if (httpServer) {
    setClientErrorHandler(httpServer, config.logger)
  }

  //// 是否监听
  // eslint-disable-next-line eqeqeq
  const watchEnabled = serverConfig.watch !== null

  //// chokidar库监听文件变动
  const watcher = watchEnabled
    ? (chokidar.watch(
        // config file dependencies and env file might be outside of root
        [root, ...config.configFileDependencies, config.envDir],
        resolvedWatchOptions,
      ) as FSWatcher)
    : //// 新建一个空的函数watcher
      createNoopWatcher(resolvedWatchOptions)

  //// 模块依赖图
  const moduleGraph: ModuleGraph = new ModuleGraph((url, ssr) =>
    //// ! container是利用闭包，执行前定义即可，调用所有插件中实现的 resolveId 钩子
    container.resolveId(url, undefined, { ssr }),
  )

  //// 创建插件容器
  const container = await createPluginContainer(config, moduleGraph, watcher)

  ////  获取关闭http服务器的函数
  const closeHttpServer = createServerCloseFn(httpServer)

  let exitProcess: () => void

  //// dev html转换函数
  const devHtmlTransformFn = createDevHtmlTransformFn(config)

  //// 返回的server对象
  let server: ViteDevServer = {
    config,
    middlewares,
    httpServer,
    watcher,
    pluginContainer: container,
    ws,
    moduleGraph,
    //// listen时赋值
    resolvedUrls: null, // will be set on listen
    ssrTransform(
      code: string,
      inMap: SourceMap | { mappings: '' } | null,
      url: string,
      originalCode = code,
    ) {
      return ssrTransform(code, inMap, url, originalCode, server.config)
    },
    transformRequest(url, options) {
      //// 转换请求
      return transformRequest(url, server, options)
    },
    async warmupRequest(url, options) {
      //// 预热文件请求转换
      await transformRequest(url, server, options).catch((e) => {
        if (
          e?.code === ERR_OUTDATED_OPTIMIZED_DEP ||
          e?.code === ERR_CLOSED_SERVER
        ) {
          // these are expected errors
          return
        }
        // Unexpected error, log the issue but avoid an unhandled exception
        server.config.logger.error(`Pre-transform error: ${e.message}`, {
          error: e,
          timestamp: true,
        })
      })
    },
    transformIndexHtml(url, html, originalUrl) {
      //// 转换html
      return devHtmlTransformFn(server, url, html, originalUrl)
    },
    async ssrLoadModule(url, opts?: { fixStacktrace?: boolean }) {
      if (isDepsOptimizerEnabled(config, true)) {
        await initDevSsrDepsOptimizer(config, server)
      }
      return ssrLoadModule(
        url,
        server,
        undefined,
        undefined,
        opts?.fixStacktrace,
      )
    },
    ssrFixStacktrace(e) {
      ssrFixStacktrace(e, moduleGraph)
    },
    ssrRewriteStacktrace(stack: string) {
      return ssrRewriteStacktrace(stack, moduleGraph)
    },
    async reloadModule(module) {
      if (serverConfig.hmr !== false && module.file) {
        updateModules(module.file, [module], Date.now(), server)
      }
    },
    async listen(port?: number, isRestart?: boolean) {
      //// 开启服务
      await startServer(server, port)

      if (httpServer) {
        //// 解析服务的url并保存
        server.resolvedUrls = await resolveServerUrls(
          httpServer,
          config.server,
          config,
        )

        if (!isRestart && config.server.open) server.openBrowser()
      }
      return server
    },
    openBrowser() {
      //// 打开浏览器
      const options = server.config.server
      const url =
        server.resolvedUrls?.local[0] ?? server.resolvedUrls?.network[0]
      if (url) {
        const path =
          typeof options.open === 'string'
            ? new URL(options.open, url).href
            : url

        // We know the url that the browser would be opened to, so we can
        // start the request while we are awaiting the browser. This will
        // start the crawling of static imports ~500ms before.
        // preTransformRequests needs to be enabled for this optimization.
        if (server.config.server.preTransformRequests) {
          setTimeout(() => {
            const getMethod = path.startsWith('https:') ? httpsGet : httpGet

            getMethod(
              path,
              {
                headers: {
                  // Allow the history middleware to redirect to /index.html
                  Accept: 'text/html',
                },
              },
              (res) => {
                res.on('end', () => {
                  // Ignore response, scripts discovered while processing the entry
                  // will be preprocessed (server.config.server.preTransformRequests)
                })
              },
            )
              .on('error', () => {
                // Ignore errors
              })
              .end()
          }, 0)
        }

        _openBrowser(path, true, server.config.logger)
      } else {
        server.config.logger.warn('No URL available to open in browser')
      }
    },
    async close() {
      //// 关闭服务器
      if (!middlewareMode) {
        process.off('SIGTERM', exitProcess)
        if (process.env.CI !== 'true') {
          process.stdin.off('end', exitProcess)
        }
      }
      await Promise.allSettled([
        watcher.close(),
        ws.close(),
        container.close(),
        getDepsOptimizer(server.config)?.close(),
        getDepsOptimizer(server.config, true)?.close(),
        closeHttpServer(),
      ])
      // Await pending requests. We throw early in transformRequest
      // and in hooks if the server is closing for non-ssr requests,
      // so the import analysis plugin stops pre-transforming static
      // imports and this block is resolved sooner.
      // During SSR, we let pending requests finish to avoid exposing
      // the server closed error to the users.
      while (server._pendingRequests.size > 0) {
        await Promise.allSettled(
          [...server._pendingRequests.values()].map(
            (pending) => pending.request,
          ),
        )
      }
      server.resolvedUrls = null
    },
    printUrls() {
      //// 打印服务的url
      if (server.resolvedUrls) {
        printServerUrls(
          server.resolvedUrls,
          serverConfig.host,
          config.logger.info,
        )
      } else if (middlewareMode) {
        throw new Error('cannot print server URLs in middleware mode.')
      } else {
        throw new Error(
          'cannot print server URLs before server.listen is called.',
        )
      }
    },
    bindCLIShortcuts(options) {
      //// 绑定快捷键
      bindCLIShortcuts(server, options)
    },
    async restart(forceOptimize?: boolean) {
      if (!server._restartPromise) {
        server._forceOptimizeOnRestart = !!forceOptimize
        server._restartPromise = restartServer(server).finally(() => {
          server._restartPromise = null
          server._forceOptimizeOnRestart = false
        })
      }
      return server._restartPromise
    },

    _setInternalServer(_server: ViteDevServer) {
      // Rebind internal the server variable so functions reference the user
      // server instance after a restart
      server = _server
    },
    _restartPromise: null,
    _importGlobMap: new Map(),
    _forceOptimizeOnRestart: false,
    _pendingRequests: new Map(),
    _fsDenyGlob: picomatch(config.server.fs.deny, { matchBase: true }),
    _shortcutsOptions: undefined,
  }

  //// 非中间件模式时监听关闭信号
  if (!middlewareMode) {
    exitProcess = async () => {
      try {
        await server.close()
      } finally {
        process.exit()
      }
    }
    process.once('SIGTERM', exitProcess)
    if (process.env.CI !== 'true') {
      process.stdin.on('end', exitProcess)
    }
  }

  //// hmr处理
  const onHMRUpdate = async (file: string, configOnly: boolean) => {
    if (serverConfig.hmr !== false) {
      try {
        await handleHMRUpdate(file, server, configOnly)
      } catch (err) {
        ws.send({
          type: 'error',
          err: prepareError(err),
        })
      }
    }
  }

  const onFileAddUnlink = async (file: string, isUnlink: boolean) => {
    file = normalizePath(file)
    await container.watchChange(file, { event: isUnlink ? 'delete' : 'create' })
    await handleFileAddUnlink(file, server, isUnlink)
    await onHMRUpdate(file, true)
  }

  watcher.on('change', async (file) => {
    file = normalizePath(file)
    await container.watchChange(file, { event: 'update' })
    // invalidate module graph cache on file change
    moduleGraph.onFileChange(file)

    await onHMRUpdate(file, false)
  })

  watcher.on('add', (file) => onFileAddUnlink(file, false))
  watcher.on('unlink', (file) => onFileAddUnlink(file, true))

  ws.on('vite:invalidate', async ({ path, message }: InvalidatePayload) => {
    const mod = moduleGraph.urlToModuleMap.get(path)
    if (mod && mod.isSelfAccepting && mod.lastHMRTimestamp > 0) {
      config.logger.info(
        colors.yellow(`hmr invalidate `) +
          colors.dim(path) +
          (message ? ` ${message}` : ''),
        { timestamp: true },
      )
      const file = getShortName(mod.file!, config.root)
      updateModules(
        file,
        [...mod.importers],
        mod.lastHMRTimestamp,
        server,
        true,
      )
    }
  })

  if (!middlewareMode && httpServer) {
    httpServer.once('listening', () => {
      // update actual port since this may be different from initial value
      serverConfig.port = (httpServer.address() as net.AddressInfo).port
    })
  }

  //// 串行收集configureServer hook，configureServer 钩子将在内部中间件被安装前调用，configureServer 返回一个函数，将会在内部中间件安装后被调用
  // apply server configuration hooks from plugins
  const postHooks: ((() => void) | void)[] = []
  for (const hook of config.getSortedPluginHooks('configureServer')) {
    postHooks.push(await hook(server))
  }

  //// 内部中间件
  // Internal middlewares ------------------------------------------------------

  //// 请求时间打印中间件
  // request timer
  if (process.env.DEBUG) {
    middlewares.use(timeMiddleware(root))
  }

  //// 跨域中间件
  // cors (enabled by default)
  const { cors } = serverConfig
  if (cors !== false) {
    middlewares.use(corsMiddleware(typeof cors === 'boolean' ? {} : cors))
  }

  //// 代理中间件
  // proxy
  const { proxy } = serverConfig
  if (proxy) {
    const middlewareServer =
      (isObject(serverConfig.middlewareMode)
        ? serverConfig.middlewareMode.server
        : null) || httpServer
    middlewares.use(proxyMiddleware(middlewareServer, proxy, config))
  }

  //// base处理中间件
  // base
  if (config.base !== '/') {
    middlewares.use(baseMiddleware(config.rawBase, middlewareMode))
  }

  //// 在编辑器打开代码的中间件
  // open in editor support
  middlewares.use('/__open-in-editor', launchEditorMiddleware())

  //// ping检查保持连接中间件
  // ping request handler
  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  middlewares.use(function viteHMRPingMiddleware(req, res, next) {
    if (req.headers['accept'] === 'text/x-vite-ping') {
      res.writeHead(204).end()
    } else {
      next()
    }
  })

  //// public文件夹资源服务中间件
  // serve static files under /public
  // this applies before the transform middleware so that these files are served
  // as-is without transforms.
  if (config.publicDir) {
    middlewares.use(servePublicMiddleware(server))
  }

  //// transform中间件
  // main transform middleware
  middlewares.use(transformMiddleware(server))

  // serve static files
  //// 原始资源服务中间件
  middlewares.use(serveRawFsMiddleware(server))
  //// 静态资源服务中间件
  middlewares.use(serveStaticMiddleware(server))

  //// html fallback 中间件
  // html fallback
  if (config.appType === 'spa' || config.appType === 'mpa') {
    middlewares.use(htmlFallbackMiddleware(root, config.appType === 'spa'))
  }

  //// 在内部中间件安装后，调用configureServer 返回的函数
  // run post config hooks
  // This is applied before the html middleware so that user middleware can
  // serve custom content instead of index.html.
  postHooks.forEach((fn) => fn && fn())

  if (config.appType === 'spa' || config.appType === 'mpa') {
    //// transform index的中间件
    // transform index.html
    middlewares.use(indexHtmlMiddleware(root, server))

    //// 处理404的中间件
    // handle 404s
    middlewares.use(notFoundMiddleware())
  }

  //// 错误处理中间件
  // error handler
  middlewares.use(errorMiddleware(server, middlewareMode))

  //// httpServer.listen可以多次调用，但是避免buildStart多次调用
  // httpServer.listen can be called multiple times
  // when port when using next port number
  // this code is to avoid calling buildStart multiple times
  //// 在初始化的服务器
  let initingServer: Promise<void> | undefined

  //// 是否初始化过
  let serverInited = false

  const initServer = async () => {
    //// 初始化过就返回
    if (serverInited) return

    //// 初始化中则返回在初始化的服务器
    if (initingServer) return initingServer

    //// 服务器初始化函数
    initingServer = (async function () {
      //// 执行buildStart hook
      await container.buildStart({})

      //// ! 执行预构建
      // start deps optimizer after all container plugins are ready
      if (isDepsOptimizerEnabled(config, false)) {
        await initDepsOptimizer(config, server)
      }

      //// 预热常用文件
      warmupFiles(server)

      //// 在初始化的服务器清空
      initingServer = undefined

      //// 已经初始化过
      serverInited = true
    })()

    return initingServer
  }

  if (!middlewareMode && httpServer) {
    //// 不是中间件模式时，重写listen来支持预构建
    // overwrite listen to init optimizer before server start
    const listen = httpServer.listen.bind(httpServer)

    httpServer.listen = (async (port: number, ...args: any[]) => {
      try {
        //// 先启动ws服务器
        // ensure ws server started
        ws.listen()

        //// 执行服务器初始化
        await initServer()
      } catch (e) {
        httpServer.emit('error', e)

        return
      }

      return listen(port, ...args)
    }) as any
  } else {
    //// 是中间件模式时，直接启动ws服务器
    if (options.ws) {
      ws.listen()
    }

    //// 然后初始化服务器
    await initServer()
  }

  //// 返回服务器对象
  return server
}

//// 开启服务器
async function startServer(
  server: ViteDevServer,
  inlinePort?: number,
): Promise<void> {
  //// 获取httpServer
  const httpServer = server.httpServer

  if (!httpServer) {
    throw new Error('Cannot call server.listen in middleware mode.')
  }

  //// 获取server配置
  const options = server.config.server

  //// 解析host
  const hostname = await resolveHostname(options.host)

  //// 解析port
  const configPort = inlinePort ?? options.port
  // When using non strict port for the dev server, the running port can be different from the config one.
  // When restarting, the original port may be available but to avoid a switch of URL for the running
  // browser tabs, we enforce the previously used port, expect if the config port changed.
  const port =
    (!configPort || configPort === server._configServerPort
      ? server._currentServerPort
      : configPort) ?? DEFAULT_DEV_PORT
  server._configServerPort = configPort

  //// 开启服务器
  const serverPort = await httpServerStart(httpServer, {
    port,
    strictPort: options.strictPort,
    host: hostname.host,
    logger: server.config.logger,
  })
  server._currentServerPort = serverPort
}

//// 创建关闭服务器的函数
function createServerCloseFn(server: HttpServer | null) {
  if (!server) {
    return () => {}
  }

  //// 服务是否开启
  let hasListened = false

  //// 记录下的开启的socket
  const openSockets = new Set<net.Socket>()

  server.on('connection', (socket) => {
    //// 每次socket连接都记录下来
    openSockets.add(socket)

    socket.on('close', () => {
      //// 每次socket关闭都删除记录
      openSockets.delete(socket)
    })
  })

  server.once('listening', () => {
    //// 服务开启时记录开启
    hasListened = true
  })

  return () =>
    new Promise<void>((resolve, reject) => {
      //// 关闭每一个socket
      openSockets.forEach((s) => s.destroy())

      if (hasListened) {
        //// 如果还在监听，关闭服务器这样避免新的socket
        server.close((err) => {
          if (err) {
            reject(err)
          } else {
            resolve()
          }
        })
      } else {
        resolve()
      }
    })
}

//// 解析allow的目录路径
function resolvedAllowDir(root: string, dir: string): string {
  return normalizePath(path.resolve(root, dir))
}

//// 解析server配置
export function resolveServerOptions(
  root: string,
  raw: ServerOptions | undefined,
  logger: Logger,
): ResolvedServerOptions {
  const server: ResolvedServerOptions = {
    preTransformRequests: true,
    ...(raw as Omit<ResolvedServerOptions, 'sourcemapIgnoreList'>),
    sourcemapIgnoreList:
      raw?.sourcemapIgnoreList === false
        ? () => false
        : raw?.sourcemapIgnoreList || isInNodeModules,
    middlewareMode: !!raw?.middlewareMode,
  }
  let allowDirs = server.fs?.allow
  const deny = server.fs?.deny || ['.env', '.env.*', '*.{crt,pem}']

  if (!allowDirs) {
    allowDirs = [searchForWorkspaceRoot(root)]
  }

  allowDirs = allowDirs.map((i) => resolvedAllowDir(root, i))

  // only push client dir when vite itself is outside-of-root
  const resolvedClientDir = resolvedAllowDir(root, CLIENT_DIR)
  if (!allowDirs.some((dir) => isParentDirectory(dir, resolvedClientDir))) {
    allowDirs.push(resolvedClientDir)
  }

  server.fs = {
    strict: server.fs?.strict ?? true,
    allow: allowDirs,
    deny,
  }

  if (server.origin?.endsWith('/')) {
    server.origin = server.origin.slice(0, -1)
    logger.warn(
      colors.yellow(
        `${colors.bold('(!)')} server.origin should not end with "/". Using "${
          server.origin
        }" instead.`,
      ),
    )
  }

  return server
}

//// 重启服务器
async function restartServer(server: ViteDevServer) {
  global.__vite_start_time = performance.now()
  const shortcutsOptions = server._shortcutsOptions

  let inlineConfig = server.config.inlineConfig
  if (server._forceOptimizeOnRestart) {
    inlineConfig = mergeConfig(inlineConfig, {
      optimizeDeps: {
        force: true,
      },
    })
  }

  let newServer = null
  try {
    // delay ws server listen
    newServer = await _createServer(inlineConfig, { ws: false })
  } catch (err: any) {
    server.config.logger.error(err.message, {
      timestamp: true,
    })
    server.config.logger.error('server restart failed', { timestamp: true })
    return
  }

  await server.close()

  // Assign new server props to existing server instance
  newServer._configServerPort = server._configServerPort
  newServer._currentServerPort = server._currentServerPort
  Object.assign(server, newServer)
  // Rebind internal server variable so functions reference the user server
  newServer._setInternalServer(server)

  const {
    logger,
    server: { port, middlewareMode },
  } = server.config
  if (!middlewareMode) {
    await server.listen(port, true)
  } else {
    server.ws.listen()
  }
  logger.info('server restarted.', { timestamp: true })

  if (shortcutsOptions) {
    shortcutsOptions.print = false
    bindCLIShortcuts(newServer, shortcutsOptions)
  }
}

//// 重启服务器并打印urls
/**
 * Internal function to restart the Vite server and print URLs if changed
 */
export async function restartServerWithUrls(
  server: ViteDevServer,
): Promise<void> {
  if (server.config.server.middlewareMode) {
    await server.restart()
    return
  }

  const { port: prevPort, host: prevHost } = server.config.server
  const prevUrls = server.resolvedUrls

  await server.restart()

  const {
    logger,
    server: { port, host },
  } = server.config
  if (
    (port ?? DEFAULT_DEV_PORT) !== (prevPort ?? DEFAULT_DEV_PORT) ||
    host !== prevHost ||
    diffDnsOrderChange(prevUrls, server.resolvedUrls)
  ) {
    logger.info('')
    server.printUrls()
  }
}
