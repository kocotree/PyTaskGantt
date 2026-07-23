const API_PORT = import.meta.env.VITE_API_PORT || '3002'

function apiBase() {
  if (import.meta.env.PROD) return '/api'
  const hostname = globalThis.window?.location?.hostname || 'localhost'
  return `http://${hostname}:${API_PORT}/api`
}

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'REQUEST_FAILED', details = null } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

let unauthorizedHandler = null
let handlingUnauthorized = false

export function setUnauthorizedHandler(handler) {
  unauthorizedHandler = handler
}

function joinPath(path) {
  return `${apiBase()}${path.startsWith('/') ? path : `/${path}`}`
}

export function getApiUrl(path) {
  return joinPath(path)
}

async function parseResponse(response) {
  if (response.status === 204) return null
  const type = response.headers.get('content-type') || ''
  if (type.includes('application/json')) return response.json().catch(() => ({}))
  return response.text()
}

function errorFromResponse(response, payload) {
  const wrapped = payload && typeof payload === 'object' ? payload.error : null
  const message = wrapped?.message || payload?.message || payload?.error || `请求失败（${response.status}）`
  return new ApiError(String(message), {
    status: response.status,
    code: wrapped?.code || payload?.code || `HTTP_${response.status}`,
    details: wrapped?.details || payload?.details || null,
  })
}

function notifyUnauthorized(error) {
  if (!unauthorizedHandler || handlingUnauthorized) return
  handlingUnauthorized = true
  Promise.resolve(unauthorizedHandler(error)).finally(() => {
    handlingUnauthorized = false
  })
}

export async function apiRequest(path, options = {}) {
  const {
    body,
    headers = {},
    skipAuthRedirect = false,
    signal,
    ...fetchOptions
  } = options
  const finalHeaders = new Headers(headers)
  let finalBody = body

  if (body != null && !(body instanceof FormData) && typeof body !== 'string' && !(body instanceof Blob)) {
    finalHeaders.set('Content-Type', 'application/json')
    finalBody = JSON.stringify(body)
  }

  let response
  try {
    response = await fetch(joinPath(path), {
      cache: 'no-store',
      credentials: 'include',
      ...fetchOptions,
      headers: finalHeaders,
      body: finalBody,
      signal,
    })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    throw new ApiError(error?.message || '无法连接服务器', { code: 'NETWORK_ERROR' })
  }

  const payload = await parseResponse(response)
  if (!response.ok) {
    const error = errorFromResponse(response, payload)
    if (response.status === 401 && !skipAuthRedirect) notifyUnauthorized(error)
    throw error
  }
  return payload
}

export function toQuery(params = {}) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) continue
    query.set(key, Array.isArray(value) ? value.join(',') : String(value))
  }
  const text = query.toString()
  return text ? `?${text}` : ''
}

export async function downloadFromApi(path, filename) {
  let response
  try {
    response = await fetch(joinPath(path), { credentials: 'include', cache: 'no-store' })
  } catch (error) {
    throw new ApiError(error?.message || '下载失败', { code: 'NETWORK_ERROR' })
  }
  if (!response.ok) {
    const payload = await parseResponse(response)
    const error = errorFromResponse(response, payload)
    if (response.status === 401) notifyUnauthorized(error)
    throw error
  }
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}
