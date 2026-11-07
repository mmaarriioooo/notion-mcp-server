import type { OpenAPIV3, OpenAPIV3_1 } from 'openapi-types'
import OpenAPIClientAxios from 'openapi-client-axios'
import type { AxiosInstance } from 'axios'
import { Headers } from './polyfill-headers'
import { isFileUploadParameter } from '../openapi/file-upload'

export type RetryConfig = {
  /** How many times a rate-limited (429) request is retried. Default: 3 */
  maxRetries?: number
  /**
   * Longest wait before a single retry, in milliseconds. If Notion asks for a
   * longer wait (via Retry-After), the 429 is returned immediately instead of
   * blocking the tool call. Default: 10000
   */
  maxDelayMs?: number
  /** Wait used when the response has no usable Retry-After header; doubles per attempt. Default: 1000 */
  baseDelayMs?: number
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>
}

export type HttpClientConfig = {
  baseUrl: string
  headers?: Record<string, string>
  retry?: RetryConfig
}

export type HttpClientResponse<T = any> = {
  data: T
  status: number
  headers: Headers
}

export class HttpClientError extends Error {
  constructor(
    message: string,
    public status: number,
    public data: any,
    public headers?: Headers,
  ) {
    super(`${status} ${message}`)
    this.name = 'HttpClientError'
  }
}

export class HttpClient {
  private api: Promise<AxiosInstance>
  private client: OpenAPIClientAxios
  private config: HttpClientConfig
  private openApiSpec: OpenAPIV3.Document | OpenAPIV3_1.Document

  constructor(config: HttpClientConfig, openApiSpec: OpenAPIV3.Document | OpenAPIV3_1.Document) {
    this.config = config
    this.openApiSpec = openApiSpec
    // @ts-expect-error
    this.client = new (OpenAPIClientAxios.default ?? OpenAPIClientAxios)({
      definition: openApiSpec,
      axiosConfigDefaults: {
        baseURL: config.baseUrl,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'notion-mcp-server',
          ...config.headers,
        },
      },
    })
    this.api = this.client.init()
  }

  /**
   * Resolve a possibly-$ref'd parameter to its inline definition.
   * Only local refs (e.g. `#/components/parameters/notionVersion`) are supported.
   */
  private resolveParameter(
    param: OpenAPIV3.ParameterObject | OpenAPIV3.ReferenceObject,
  ): OpenAPIV3.ParameterObject | null {
    if (!('$ref' in param)) {
      return param as OpenAPIV3.ParameterObject
    }
    const ref = param.$ref
    if (!ref.startsWith('#/')) {
      return null
    }
    let node: any = this.openApiSpec
    for (const segment of ref.slice(2).split('/')) {
      node = node?.[segment]
      if (node === undefined) return null
    }
    return node && node.name ? (node as OpenAPIV3.ParameterObject) : null
  }

  /**
   * Build the server-managed header parameters declared on an operation.
   *
   * Header parameters (currently `Notion-Version`) are not exposed as tool
   * inputs; their value comes from the operation's header-parameter `default`
   * in the OpenAPI spec. This lets each endpoint pin the API version it needs —
   * e.g. the page-markdown endpoints require `2026-03-11` while the rest of the
   * API stays on `2025-09-03`. A header the caller configured globally (via
   * HttpClientConfig.headers) takes precedence and is left untouched.
   */
  private buildDefaultHeaders(operation: OpenAPIV3.OperationObject): Record<string, string> {
    const configured = new Set(Object.keys(this.config.headers ?? {}).map((key) => key.toLowerCase()))
    const headers: Record<string, string> = {}
    for (const param of operation.parameters ?? []) {
      const resolved = this.resolveParameter(param)
      if (!resolved || resolved.in !== 'header' || configured.has(resolved.name.toLowerCase())) {
        continue
      }
      const schema = resolved.schema as OpenAPIV3.SchemaObject | undefined
      if (schema && schema.default !== undefined) {
        headers[resolved.name] = String(schema.default)
      }
    }
    return headers
  }

  /**
   * Run a request, retrying it when Notion answers 429 (rate limited).
   *
   * Notion allows an average of ~3 requests per second per integration and
   * tells clients how long to back off via the Retry-After header (seconds).
   * A 429 means the request was not processed, so retrying is safe for every
   * method. Other errors are rethrown unchanged.
   */
  private async callWithRateLimitRetry<R>(request: () => Promise<R>): Promise<R> {
    const maxRetries = this.config.retry?.maxRetries ?? 3
    const maxDelayMs = this.config.retry?.maxDelayMs ?? 10_000
    const baseDelayMs = this.config.retry?.baseDelayMs ?? 1_000
    const sleep = this.config.retry?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

    for (let attempt = 0; ; attempt++) {
      try {
        return await request()
      } catch (error: any) {
        if (error?.response?.status !== 429 || attempt >= maxRetries) {
          throw error
        }
        const retryAfterMs = parseRetryAfterMs(error.response.headers)
        const delayMs = retryAfterMs ?? baseDelayMs * 2 ** attempt
        if (delayMs > maxDelayMs) {
          // Waiting that long would stall the tool call; surface the 429 instead.
          throw error
        }
        if (process.env.NODE_ENV !== 'test') {
          console.error(`Rate limited by Notion (429), retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})`)
        }
        await sleep(delayMs)
      }
    }
  }

  /**
   * Execute an OpenAPI operation
   */
  async executeOperation<T = any>(
    operation: OpenAPIV3.OperationObject & { method: string; path: string },
    params: Record<string, any> = {},
  ): Promise<HttpClientResponse<T>> {
    const api = await this.api
    const operationId = operation.operationId
    if (!operationId) {
      throw new Error('Operation ID is required')
    }

    // Adding an upload endpoint to the spec must not grant tools local filesystem access.
    // Uploads require an explicit file-access policy before they can be supported.
    if (isFileUploadParameter(operation).length > 0) {
      throw new Error('File uploads are not supported: local file access is disabled')
    }

    // Separate parameters based on their location
    const urlParameters: Record<string, any> = {}
    const bodyParams: Record<string, any> = { ...params }

    // Extract path and query parameters based on operation definition
    if (operation.parameters) {
      for (const param of operation.parameters) {
        if ('name' in param && param.name && param.in) {
          if (param.in === 'path' || param.in === 'query') {
            if (params[param.name] !== undefined) {
              urlParameters[param.name] = params[param.name]
              delete bodyParams[param.name]
            }
          }
        }
      }
    }

    // Add all parameters as url parameters if there is no requestBody defined
    if (!operation.requestBody) {
      for (const key in bodyParams) {
        if (bodyParams[key] !== undefined) {
          urlParameters[key] = bodyParams[key]
          delete bodyParams[key]
        }
      }
    }

    const operationFn = (api as any)[operationId]
    if (!operationFn) {
      throw new Error(`Operation ${operationId} not found`)
    }

    try {
      const hasBody = Object.keys(bodyParams).length > 0
      const headers = { ...(hasBody ? { 'Content-Type': 'application/json' } : { 'Content-Type': null }) }
      const requestConfig = {
        headers: {
          ...this.buildDefaultHeaders(operation),
          ...headers,
        },
      }

      // first argument is url parameters, second is body parameters
      const response: any = await this.callWithRateLimitRetry(() =>
        operationFn(urlParameters, hasBody ? bodyParams : undefined, requestConfig),
      )

      // Convert axios headers to Headers object
      const responseHeaders = new Headers()
      Object.entries(response.headers).forEach(([key, value]) => {
        if (value) responseHeaders.append(key, value.toString())
      })

      return {
        data: response.data,
        status: response.status,
        headers: responseHeaders,
      }
    } catch (error: any) {
      if (error.response) {
        // Only log errors in non-test environments to keep test output clean
        if (process.env.NODE_ENV !== 'test') {
          console.error('Error in http client', {
            status: error.response.status,
            statusText: error.response.statusText,
          })
        }
        const headers = new Headers()
        Object.entries(error.response.headers).forEach(([key, value]) => {
          if (value) headers.append(key, value.toString())
        })

        throw new HttpClientError(error.response.statusText || 'Request failed', error.response.status, error.response.data, headers)
      }
      throw error
    }
  }
}

/**
 * Read a Retry-After header (delay in seconds, or an HTTP date) as milliseconds.
 * Returns undefined when the header is missing or unparseable.
 */
function parseRetryAfterMs(headers: unknown): number | undefined {
  if (!headers || typeof headers !== 'object') return undefined
  let raw: unknown
  const get = (headers as { get?: unknown }).get
  if (typeof get === 'function') {
    raw = get.call(headers, 'retry-after')
  }
  if (raw === undefined || raw === null) {
    const entry = Object.entries(headers as Record<string, unknown>).find(([key]) => key.toLowerCase() === 'retry-after')
    raw = entry?.[1]
  }
  if (raw === undefined || raw === null || raw === '') return undefined

  const value = String(raw).trim()
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000)
  }
  const date = Date.parse(value)
  if (!Number.isNaN(date)) {
    return Math.max(0, date - Date.now())
  }
  return undefined
}
