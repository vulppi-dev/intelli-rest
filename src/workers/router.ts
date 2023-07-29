import { StatusCodes } from 'http-status-codes'
import _ from 'lodash'
import { unescape } from 'querystring'
import { pathToFileURL } from 'url'
import { parentPort } from 'worker_threads'
import { isDev } from '../utils/constants'
import {
  findMiddlewarePathnames,
  findRoutePathnames,
  sendResponseAll,
} from '../utils/router-tools'

function encapsulateModule(v: string) {
  if (!isDev) return v
  return `${v}?update=${Date.now()}`
}

parentPort!.on(
  'message',
  async ({ config, basePath, data, requestId }: WorkerProps) => {
    const context = {
      ...data,
      params: {},
      query: new URLSearchParams(data.query || ''),
    } as IntREST.IntRequest

    try {
      const routePathnames = await findRoutePathnames(basePath, data.path)

      if (!routePathnames.length) {
        return await sendResponseAll(
          {
            status: StatusCodes.NOT_FOUND,
            body: {
              message: config.messages?.NOT_FOUND || 'Not found',
            },
            headers: {
              'Content-Type': 'application/json',
            },
          },
          context.headers,
          requestId,
        )
      }

      const method = context.method
      const routeModules = await Promise.all(
        routePathnames.map(async (r) => ({
          module: await import(
            encapsulateModule(pathToFileURL(r.pathname).toString())
          ),
          paramRegexp: r.paramRegexp,
          vars: r.vars,
          pathname: r.pathname,
        })),
      )
      const routeFiltered = routeModules.filter((r) => !!r.module[method])

      if (!routeFiltered.length) {
        return await sendResponseAll(
          {
            status: StatusCodes.METHOD_NOT_ALLOWED,
            body: {
              message:
                config.messages?.METHOD_NOT_ALLOWED || 'Method not allowed',
            },
            headers: {
              'Content-Type': 'application/json',
            },
          },
          context.headers,
          requestId,
        )
      }

      const { module, pathname, paramRegexp, vars } = routeFiltered[0]
      const requestHandler: IntREST.RequestHandler | undefined = module[method]

      if (typeof requestHandler !== 'function') {
        return await sendResponseAll(
          {
            status: StatusCodes.INTERNAL_SERVER_ERROR,
            body: {
              message:
                config.messages?.INTERNAL_SERVER_ERROR ||
                'Internal server error',
            },
            headers: {
              'Content-Type': 'application/json',
            },
          },
          context.headers,
          requestId,
        )
      }

      const paramsValues = Array.from(data.path.match(paramRegexp) || []).slice(
        1,
      )
      context.params = _.zipObject(vars, paramsValues.map(unescape))

      const middlewarePathnames = await findMiddlewarePathnames(
        basePath,
        pathname,
      )

      const middlewareList = (
        await Promise.all(
          middlewarePathnames.map(async (r) => {
            const m = await import(
              encapsulateModule(pathToFileURL(r).toString())
            )
            return {
              handler: m['middleware'] as IntREST.MiddlewareHandler,
              pathname: r,
            }
          }),
        )
      ).filter((m) => !!m.handler)

      let response: IntREST.IntResponse | null = null
      for (const middleware of middlewareList) {
        response = await new Promise<IntREST.IntResponse | null>(
          async (resolve, reject) => {
            let timeoutId: NodeJS.Timeout | null = null
            let resolved = false
            try {
              const res =
                (await middleware.handler(context, (c) => {
                  if (timeoutId) clearTimeout(timeoutId)
                  context.custom = _.merge(context.custom, c)
                  resolved = true
                })) ?? null

              if (res || resolved) resolve(res)

              timeoutId = setTimeout(() => {
                reject(
                  new Error(
                    `Middleware handler timeout: ${middleware.pathname}`,
                  ),
                )
              }, config.limits?.middleware?.timeout || 5000)
            } catch (error) {
              reject(error)
            }
          },
        )
        if (response) {
          break
        }
      }

      if (!response) {
        response = (await requestHandler!(context)) ?? null
      }

      if (response) {
        return await sendResponseAll(response, context.headers, requestId)
      }
      return await sendResponseAll(
        {
          status: StatusCodes.OK,
        },
        context.headers,
        requestId,
      )
    } catch (error) {
      console.error(error)
      if (error instanceof Error) {
        return await sendResponseAll(
          {
            status: StatusCodes.INTERNAL_SERVER_ERROR,
            body: {
              message: error.message,
            },
            headers: {
              'Content-Type': 'application/json',
            },
          },
          context.headers,
          requestId,
        )
      } else if (typeof error === 'object' && error != null) {
        return await sendResponseAll(error, context.headers, requestId)
      }

      throw error
    }
  },
)
