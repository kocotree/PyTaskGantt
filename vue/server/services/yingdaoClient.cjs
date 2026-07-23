'use strict';

const {
  createRateLimiter,
  defaultSleep,
} = require('./rateLimiter.cjs');

const DEFAULT_BASE_URL = 'https://api.yingdao.com';
const TOKEN_PATH = '/oapi/token/v2/token/create';

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function redactSensitive(value, secrets = []) {
  let text = String(value ?? '');
  text = text
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/([?&](?:accessKeyId|accessKeySecret|accessToken|token)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/(\b(?:accessKeyId|accessKeySecret|accessToken|token)\b\s*[:=]\s*)["']?[^,;\s"'}]+["']?/gi, '$1[REDACTED]')
    .replace(/("(?:accessKeyId|accessKeySecret|accessToken|token)"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2');

  for (const secret of secrets) {
    if (secret === undefined || secret === null || String(secret) === '') continue;
    text = text.split(String(secret)).join('[REDACTED]');
  }
  return text;
}

function sanitizeForLog(value, secrets = [], seen = new WeakSet()) {
  if (typeof value === 'string') return redactSensitive(value, secrets);
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => sanitizeForLog(item, secrets, seen));

  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = /authorization|access.?key|access.?token|secret|token/i.test(key)
      ? '[REDACTED]'
      : sanitizeForLog(item, secrets, seen);
  }
  return result;
}

class YingdaoApiError extends Error {
  constructor(message, {
    status = null,
    code = null,
    retryable = false,
    cause,
    secrets = [],
  } = {}) {
    const safeCause = cause
      ? new Error(redactSensitive(cause.message || String(cause), secrets))
      : undefined;
    super(redactSensitive(message, secrets), safeCause ? { cause: safeCause } : undefined);
    this.name = 'YingdaoApiError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

function retryAfterMs(response) {
  const value = response && response.headers && typeof response.headers.get === 'function'
    ? response.headers.get('retry-after')
    : null;
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function calculateBackoffDelay(attempt, {
  baseDelayMs = 250,
  maxDelayMs = 5000,
  retryAfterMaxDelayMs = 60_000,
  jitterRatio = 0.25,
  random = Math.random,
  retryAfter = null,
} = {}) {
  if (retryAfter !== null) {
    // Retry-After 是服务端给出的最早重试时间，不施加负抖动；只做独立安全上限。
    return Math.max(0, Math.round(Math.min(retryAfterMaxDelayMs, retryAfter)));
  }
  const exponential = Math.min(maxDelayMs, baseDelayMs * (2 ** Math.max(0, attempt)));
  const jitter = exponential * jitterRatio * ((random() * 2) - 1);
  return Math.max(0, Math.round(exponential + jitter));
}

async function readJsonResponse(response) {
  if (response && typeof response.text === 'function') {
    const raw = await response.text();
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch (error) {
      throw new YingdaoApiError('影刀接口返回内容无法识别', {
        status: response.status,
        retryable: Number(response.status) === 429 || Number(response.status) >= 500,
        cause: error,
      });
    }
  }
  if (response && typeof response.json === 'function') return response.json();
  return {};
}

function normalizePage(body) {
  const data = body && body.data;
  const items = Array.isArray(data)
    ? data
    : Array.isArray(data && data.dataList)
      ? data.dataList
      : [];
  const page = body && body.page && typeof body.page === 'object'
    ? body.page
    : data && typeof data === 'object'
      ? {
          hasData: data.hasData,
          nextId: data.nextId,
          pages: data.pages,
          page: data.page,
        }
      : {};
  return { items, page };
}

function normalizeJobLogPagination(body, requestedPage, requestedSize, itemCount) {
  const data = body && body.data && typeof body.data === 'object' ? body.data : {};
  const embeddedPage = data.page && typeof data.page === 'object' ? data.page : {};
  const pageInfo = body && body.page && typeof body.page === 'object'
    ? body.page
    : data.pagination && typeof data.pagination === 'object'
      ? data.pagination
      : embeddedPage;
  const numberFrom = (...values) => {
    for (const value of values) {
      const number = Number(value);
      if (Number.isFinite(number) && number >= 0) return number;
    }
    return null;
  };
  const page = Math.max(1, numberFrom(pageInfo.page, pageInfo.currentPage, data.page, requestedPage) || 1);
  const size = Math.max(1, numberFrom(pageInfo.size, pageInfo.pageSize, data.size, requestedSize) || requestedSize || 100);
  const explicitTotal = numberFrom(
    pageInfo.total,
    pageInfo.totalElements,
    pageInfo.totalCount,
    pageInfo.records,
    data.total,
    data.totalElements,
    data.totalCount
  );
  const pages = numberFrom(pageInfo.pages, pageInfo.totalPages, data.pages, data.totalPages);
  const explicitHasMore = pageInfo.hasMore ?? pageInfo.has_more
    ?? data.hasMore ?? data.has_more ?? data.hasNext ?? data.hasData;
  const inferredHasMore = explicitHasMore !== undefined
    ? Boolean(explicitHasMore)
    : pages !== null
      ? page < pages
      : explicitTotal !== null
        ? page * size < explicitTotal
        : itemCount >= size;
  const consumed = (page - 1) * size + itemCount;
  const total = explicitTotal !== null ? explicitTotal : consumed + (inferredHasMore ? 1 : 0);
  return { page, size, total, hasMore: inferredHasMore };
}

function cacheEnvelope(value, { hit, stale, ageMs, fetchedAt }) {
  return {
    ...value,
    cache: {
      hit: Boolean(hit),
      stale: Boolean(stale),
      ageMs: Math.max(0, ageMs || 0),
      fetchedAt: new Date(fetchedAt).toISOString(),
    },
  };
}

function hasScheduleValue(schedule) {
  return Boolean(
    schedule
    && typeof schedule === 'object'
    && !Array.isArray(schedule)
    && Object.keys(schedule).length > 0
  );
}

function pruneCache(cache, { now, maxAgeMs, maxEntries }) {
  for (const [key, entry] of cache) {
    if (!entry || now - entry.fetchedAt > maxAgeMs) cache.delete(key);
  }
  const limit = Math.max(1, Number(maxEntries) || 1);
  if (cache.size <= limit) return;
  const oldest = [...cache.entries()]
    .sort((left, right) => left[1].fetchedAt - right[1].fetchedAt)
    .slice(0, cache.size - limit);
  for (const [key] of oldest) cache.delete(key);
}

class YingdaoClient {
  constructor({
    accessKeyId,
    accessKeySecret,
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = globalThis.fetch,
    rateLimiter = createRateLimiter(),
    now = () => Date.now(),
    sleep = defaultSleep,
    random = Math.random,
    timeoutMs = 20_000,
    maxRetries = 3,
    retryBaseDelayMs = 250,
    retryMaxDelayMs = 5_000,
    retryAfterMaxDelayMs = 60_000,
    retryJitterRatio = 0.25,
    scheduleCacheSeconds = 60,
    bindCacheMaxAgeSeconds = 300,
    jobLogCacheSeconds = 300,
    maxScheduleCacheEntries = 200,
    maxScheduleDetailCacheEntries = 500,
    maxJobLogCacheEntries = 500,
    logger = null,
  } = {}) {
    if (!accessKeyId || !accessKeySecret) {
      throw new TypeError('YINGDAO_ACCESS_KEY_ID 和 YINGDAO_ACCESS_KEY_SECRET 均为必填');
    }
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('当前运行环境没有可用的 fetch，请注入 fetchImpl');
    }

    this.accessKeyId = String(accessKeyId);
    this.accessKeySecret = String(accessKeySecret);
    this.baseUrl = String(baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.rateLimiter = rateLimiter;
    this.now = now;
    this.sleep = sleep;
    this.random = random;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.retryBaseDelayMs = retryBaseDelayMs;
    this.retryMaxDelayMs = retryMaxDelayMs;
    this.retryAfterMaxDelayMs = retryAfterMaxDelayMs;
    this.retryJitterRatio = retryJitterRatio;
    this.scheduleCacheMs = scheduleCacheSeconds * 1000;
    this.bindCacheMaxAgeMs = bindCacheMaxAgeSeconds * 1000;
    this.jobLogCacheMs = jobLogCacheSeconds * 1000;
    this.maxScheduleCacheEntries = maxScheduleCacheEntries;
    this.maxScheduleDetailCacheEntries = maxScheduleDetailCacheEntries;
    this.maxJobLogCacheEntries = maxJobLogCacheEntries;
    this.logger = logger;

    this.tokenCache = { token: null, expiresAt: 0 };
    this.tokenFlight = null;
    this.scheduleCache = new Map();
    this.scheduleDetailCache = new Map();
    this.jobLogCache = new Map();
    this.scheduleFlights = new Map();
    this.scheduleDetailFlights = new Map();
    this.jobLogFlights = new Map();
  }

  _secrets(extra = []) {
    return [this.accessKeyId, this.accessKeySecret, this.tokenCache.token, ...extra];
  }

  sanitize(value) {
    return sanitizeForLog(value, this._secrets());
  }

  _log(level, message, metadata = {}) {
    if (!this.logger || typeof this.logger[level] !== 'function') return;
    this.logger[level](
      redactSensitive(message, this._secrets()),
      sanitizeForLog(metadata, this._secrets())
    );
  }

  invalidateToken(token = null) {
    if (token === null || this.tokenCache.token === token) {
      this.tokenCache = { token: null, expiresAt: 0 };
    }
  }

  getAccessToken({ forceRefresh = false } = {}) {
    const now = this.now();
    if (!forceRefresh && this.tokenCache.token && now < this.tokenCache.expiresAt) {
      return Promise.resolve(this.tokenCache.token);
    }
    if (this.tokenFlight) return this.tokenFlight;

    if (forceRefresh) this.invalidateToken();
    this.tokenFlight = this._createAccessToken()
      .finally(() => {
        this.tokenFlight = null;
      });
    return this.tokenFlight;
  }

  async _createAccessToken() {
    const query = new URLSearchParams({
      accessKeyId: this.accessKeyId,
      accessKeySecret: this.accessKeySecret,
    });
    const body = await this._requestJson(TOKEN_PATH, {
      method: 'GET',
      query: query.toString(),
      headers: {},
      body: undefined,
    });
    const data = body && body.data && typeof body.data === 'object' ? body.data : {};
    const token = data.accessToken;
    if (body.success === false || !token) {
      throw new YingdaoApiError(`影刀鉴权失败：${body.msg || body.code || '未知错误'}`, {
        status: 401,
        code: body.code,
        secrets: this._secrets([token]),
      });
    }

    const expiresInSeconds = Number(data.expiresIn || 3600);
    const usableMs = Math.max(0, (Number.isFinite(expiresInSeconds) ? expiresInSeconds : 3600) * 1000 - 60_000);
    this.tokenCache = {
      token: String(token),
      expiresAt: this.now() + usableMs,
    };
    return this.tokenCache.token;
  }

  async _fetchWithTimeout(url, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async _requestJson(path, { method = 'POST', query = '', headers = {}, body } = {}) {
    const endpoint = String(path);
    const url = `${this.baseUrl}${endpoint}${query ? `?${query}` : ''}`;
    let lastError;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const response = await this.rateLimiter.schedule(endpoint, () => this._fetchWithTimeout(url, {
          method,
          headers,
          body,
        }));
        const responseBody = await readJsonResponse(response);
        const bodyCode = Number(responseBody && responseBody.code);
        const status = Number(response && response.status) || 0;
        const retryable = status === 429 || status >= 500 || bodyCode === 429 || bodyCode >= 500;

        if (!response.ok || retryable) {
          const error = new YingdaoApiError(
            `影刀接口错误（${status || bodyCode || '未知'}）：${responseBody.msg || responseBody.message || '请求被拒绝'}`,
            {
              status: status || null,
              code: Number.isFinite(bodyCode) ? bodyCode : null,
              retryable,
              secrets: this._secrets(),
            }
          );
          if (retryable && attempt < this.maxRetries) {
            const delayMs = calculateBackoffDelay(attempt, {
              baseDelayMs: this.retryBaseDelayMs,
              maxDelayMs: this.retryMaxDelayMs,
              retryAfterMaxDelayMs: this.retryAfterMaxDelayMs,
              jitterRatio: this.retryJitterRatio,
              random: this.random,
              retryAfter: retryAfterMs(response),
            });
            this._log('warn', '影刀接口暂时不可用，准备有限重试', {
              endpoint,
              status: status || bodyCode,
              attempt: attempt + 1,
              delayMs,
            });
            await this.sleep(delayMs);
            continue;
          }
          throw error;
        }

        return responseBody;
      } catch (error) {
        if (error instanceof YingdaoApiError) {
          if (error.retryable && attempt < this.maxRetries) {
            const delayMs = calculateBackoffDelay(attempt, {
              baseDelayMs: this.retryBaseDelayMs,
              maxDelayMs: this.retryMaxDelayMs,
              jitterRatio: this.retryJitterRatio,
              random: this.random,
            });
            await this.sleep(delayMs);
            continue;
          }
          throw error;
        }

        const timeout = error && (error.name === 'AbortError' || /abort|timeout/i.test(error.message || ''));
        lastError = new YingdaoApiError(
          timeout ? '影刀接口请求超时' : `无法连接影刀接口：${error && error.message ? error.message : '网络错误'}`,
          {
            retryable: true,
            cause: error,
            secrets: this._secrets(),
          }
        );
        if (attempt >= this.maxRetries) throw lastError;

        const delayMs = calculateBackoffDelay(attempt, {
          baseDelayMs: this.retryBaseDelayMs,
          maxDelayMs: this.retryMaxDelayMs,
          jitterRatio: this.retryJitterRatio,
          random: this.random,
        });
        this._log('warn', '影刀接口网络错误，准备有限重试', {
          endpoint,
          attempt: attempt + 1,
          delayMs,
          timeout,
        });
        await this.sleep(delayMs);
      }
    }
    throw lastError || new YingdaoApiError('影刀接口调用失败', { secrets: this._secrets() });
  }

  async request(path, payload = {}, { method = 'POST' } = {}) {
    const initialToken = await this.getAccessToken();
    const perform = token => this._requestJson(path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: method === 'GET' ? undefined : JSON.stringify(payload),
    });

    let body;
    try {
      body = await perform(initialToken);
      const code = Number(body && body.code);
      if (code === 401) {
        throw new YingdaoApiError('影刀 accessToken 已失效', {
          status: 401,
          code,
          secrets: this._secrets([initialToken]),
        });
      }
    } catch (error) {
      if (!(error instanceof YingdaoApiError) || (error.status !== 401 && error.code !== 401)) throw error;

      // 其他并发请求可能已完成刷新；仅当仍是旧 token 时发起 single-flight 强制刷新。
      const refreshedToken = this.tokenCache.token && this.tokenCache.token !== initialToken
        ? this.tokenCache.token
        : await this.getAccessToken({ forceRefresh: true });
      body = await perform(refreshedToken); // 401 只重试这一次
    }

    const code = body && body.code !== undefined ? Number(body.code) : 200;
    if (body && body.success === false || (Number.isFinite(code) && code !== 200)) {
      throw new YingdaoApiError(`影刀接口调用失败：${body.msg || body.message || body.code || '未知错误'}`, {
        code: Number.isFinite(code) ? code : null,
        secrets: this._secrets(),
      });
    }
    return body || {};
  }

  async _cachedRequest(cache, key, freshMs, staleMaxMs, loader, {
    bypassFresh = false,
    flights = null,
    maxEntries = 500,
  } = {}) {
    const now = this.now();
    pruneCache(cache, { now, maxAgeMs: staleMaxMs, maxEntries });
    const cached = cache.get(key);
    if (!bypassFresh && cached && now - cached.fetchedAt <= freshMs) {
      return cacheEnvelope(cached.value, {
        hit: true,
        stale: false,
        ageMs: now - cached.fetchedAt,
        fetchedAt: cached.fetchedAt,
      });
    }

    if (flights && flights.has(key)) return flights.get(key);

    const flight = (async () => {
      try {
        const value = await loader();
        const fetchedAt = this.now();
        cache.set(key, { value, fetchedAt });
        pruneCache(cache, { now: fetchedAt, maxAgeMs: staleMaxMs, maxEntries });
        return cacheEnvelope(value, { hit: false, stale: false, ageMs: 0, fetchedAt });
      } catch (error) {
        const upstreamStatus = Number(error && (error.status || error.code));
        if (
          error instanceof YingdaoApiError
          && upstreamStatus >= 400
          && upstreamStatus < 500
          && upstreamStatus !== 429
        ) {
          throw error;
        }
        const failureNow = this.now();
        const ageMs = cached ? failureNow - cached.fetchedAt : Infinity;
        if (cached && ageMs <= staleMaxMs) {
          return cacheEnvelope(cached.value, {
            hit: true,
            stale: true,
            ageMs,
            fetchedAt: cached.fetchedAt,
          });
        }
        throw error;
      }
    })();
    if (flights) {
      flights.set(key, flight);
      flight.finally(() => {
        if (flights.get(key) === flight) flights.delete(key);
      }).catch(() => undefined);
    }
    return flight;
  }

  listSchedules({ query = '', page = 1, size = 20 } = {}, { forceRefresh = false } = {}) {
    const payload = { page, size };
    const key = stableStringify(payload);
    return this._cachedRequest(
      this.scheduleCache,
      key,
      this.scheduleCacheMs,
      this.bindCacheMaxAgeMs,
      async () => {
        const raw = await this.request('/oapi/dispatch/v2/schedule/list', payload);
        const { items, page: pageInfo } = normalizePage(raw);
        return { schedules: items, page: pageInfo };
      },
      {
        bypassFresh: forceRefresh,
        flights: this.scheduleFlights,
        maxEntries: this.maxScheduleCacheEntries,
      }
    );
  }

  async fetchAllSchedules({ size = 100, forceRefresh = false } = {}) {
    const schedules = [];
    const cacheEntries = [];
    let page = 1;
    while (true) {
      const result = await this.listSchedules({ page, size }, { forceRefresh });
      schedules.push(...result.schedules);
      cacheEntries.push(result.cache);
      const pages = Number(result.page && (result.page.pages || result.page.totalPages)) || 0;
      if (result.schedules.length === 0 || result.schedules.length < size || (pages && page >= pages)) break;
      page += 1;
    }
    const fetchedTimes = cacheEntries
      .map(cache => Date.parse(cache && cache.fetchedAt || ''))
      .filter(Number.isFinite);
    return {
      schedules,
      cache: {
        hit: cacheEntries.length > 0 && cacheEntries.every(cache => cache && cache.hit),
        stale: cacheEntries.some(cache => cache && cache.stale),
        ageMs: Math.max(0, ...cacheEntries.map(cache => Number(cache && cache.ageMs) || 0)),
        fetchedAt: fetchedTimes.length ? new Date(Math.min(...fetchedTimes)).toISOString() : null,
      },
    };
  }

  getScheduleDetail(scheduleUuid, { forceRefresh = false } = {}) {
    const uuid = String(scheduleUuid || '').trim();
    if (!uuid) return Promise.reject(new TypeError('scheduleUuid 为必填'));
    return this._cachedRequest(
      this.scheduleDetailCache,
      uuid,
      this.scheduleCacheMs,
      this.bindCacheMaxAgeMs,
      async () => {
        const raw = await this.request('/oapi/dispatch/v2/schedule/detail', { scheduleUuid: uuid });
        return { schedule: raw.data || null };
      },
      {
        bypassFresh: forceRefresh,
        flights: this.scheduleDetailFlights,
        maxEntries: this.maxScheduleDetailCacheEntries,
      }
    );
  }

  getTrustedCachedSchedule(scheduleUuid, { maxAgeMs = this.bindCacheMaxAgeMs } = {}) {
    const uuid = String(scheduleUuid || '').trim();
    const now = this.now();
    pruneCache(this.scheduleDetailCache, {
      now,
      maxAgeMs,
      maxEntries: this.maxScheduleDetailCacheEntries,
    });
    pruneCache(this.scheduleCache, {
      now,
      maxAgeMs,
      maxEntries: this.maxScheduleCacheEntries,
    });
    const detail = this.scheduleDetailCache.get(uuid);
    if (detail && now - detail.fetchedAt <= maxAgeMs && hasScheduleValue(detail.value.schedule)) {
      return {
        schedule: detail.value.schedule,
        ageMs: now - detail.fetchedAt,
        fetchedAt: new Date(detail.fetchedAt).toISOString(),
      };
    }
    for (const cached of this.scheduleCache.values()) {
      if (now - cached.fetchedAt > maxAgeMs) continue;
      const schedule = cached.value.schedules.find(item =>
        String(item.scheduleUuid || item.schedule_uuid || '') === uuid
      );
      if (schedule) {
        return {
          schedule,
          ageMs: now - cached.fetchedAt,
          fetchedAt: new Date(cached.fetchedAt).toISOString(),
        };
      }
    }
    return null;
  }

  async ensureScheduleExists(scheduleUuid) {
    try {
      const result = await this.getScheduleDetail(scheduleUuid, { forceRefresh: true });
      if (hasScheduleValue(result.schedule)) return result;
      throw new YingdaoApiError('影刀计划不存在', {
        status: 404,
        code: 'SCHEDULE_NOT_FOUND',
      });
    } catch (error) {
      const upstreamCode = Number(error && (error.status || error.code));
      if (
        error instanceof YingdaoApiError
        && upstreamCode >= 400
        && upstreamCode < 500
        && upstreamCode !== 429
      ) {
        throw error;
      }
      const cached = this.getTrustedCachedSchedule(scheduleUuid);
      if (!cached) throw error;
      return {
        schedule: cached.schedule,
        cache: {
          hit: true,
          stale: true,
          ageMs: cached.ageMs,
          fetchedAt: cached.fetchedAt,
        },
      };
    }
  }

  async listNewestTasks(params = {}) {
    const raw = await this.request('/oapi/dispatch/v2/task/newest/list', params);
    const { items, page } = normalizePage(raw);
    return { executions: items, page, raw };
  }

  async fetchNewestTasks(params = {}) {
    const size = Number(params.size) || 100;
    let page = Number(params.page) || 1;
    const executions = [];
    while (true) {
      const result = await this.listNewestTasks({ ...params, page, size });
      executions.push(...result.executions);
      const pages = Number(result.page && result.page.pages) || 0;
      if (result.executions.length === 0 || result.executions.length < size || (pages && page >= pages)) break;
      page += 1;
    }
    return executions;
  }

  async listTaskHistory(scheduleUuid, params = {}) {
    const payload = {
      sourceUuid: String(scheduleUuid),
      cursorDirection: 'next',
      size: 100,
      ...params,
    };
    const executions = [];
    const seenCursors = new Set();
    while (true) {
      const raw = await this.request('/oapi/dispatch/v2/task/list', payload);
      const { items, page } = normalizePage(raw);
      executions.push(...items);
      const data = raw.data || {};
      const cursor = data.nextId || page.nextId;
      const hasData = data.hasData ?? page.hasData;
      if (hasData === false || !cursor || seenCursors.has(String(cursor))) break;
      seenCursors.add(String(cursor));
      payload.cursorId = cursor;
    }
    return executions;
  }

  async startTask(scheduleUuid, options = {}) {
    const idempotentUuid = typeof options === 'string'
      ? options
      : options && options.idempotentUuid;
    const raw = await this.request('/oapi/dispatch/v2/task/start', {
      scheduleUuid: String(scheduleUuid),
      idempotentUuid,
    });
    const data = raw.data || {};
    if (!data.taskUuid) {
      throw new YingdaoApiError(`影刀调度任务启动失败：${raw.msg || raw.code || '未返回 taskUuid'}`, {
        secrets: this._secrets(),
      });
    }
    return {
      taskUuid: String(data.taskUuid),
      jobUuidList: Array.isArray(data.jobUuidList) ? data.jobUuidList.map(String) : [],
      raw,
    };
  }

  async queryTask(taskUuid) {
    const raw = await this.request('/oapi/dispatch/v2/task/query', { taskUuid: String(taskUuid) });
    return { execution: raw.data || {}, raw };
  }

  async getTaskProcessDetail(taskUuid, robotClientUuid) {
    const payload = { taskUuid: String(taskUuid) };
    if (robotClientUuid) payload.robotClientUuid = String(robotClientUuid);
    const raw = await this.request('/oapi/dispatch/v2/task/process/detail', payload);
    return { jobs: Array.isArray(raw.data && raw.data.jobList) ? raw.data.jobList : [], raw };
  }

  async getExecutionJobs(taskUuid, clients = []) {
    const clientUuids = [...new Set((Array.isArray(clients) ? clients : [])
      .map(client => client && (client.robotClientUuid || client.robot_client_uuid))
      .filter(Boolean)
      .map(String))];
    if (clientUuids.length === 0) {
      return this.sanitize((await this.getTaskProcessDetail(taskUuid)).jobs);
    }

    const jobs = [];
    for (const clientUuid of clientUuids) {
      const result = await this.getTaskProcessDetail(taskUuid, clientUuid);
      jobs.push(...result.jobs);
    }
    return this.sanitize(jobs);
  }

  getJobLogs(jobUuid, {
    page = 1,
    size = 100,
    queryFilter = { sort: { sortKey: 'time', sortOrder: 'desc' } },
    forceRefresh = false,
  } = {}) {
    const payload = { jobUuid: String(jobUuid), page, size, queryFilter };
    const key = stableStringify(payload);
    return this._cachedRequest(
      this.jobLogCache,
      key,
      this.jobLogCacheMs,
      this.jobLogCacheMs,
      async () => {
        const raw = await this.request('/oapi/dispatch/v2/job/log/search', payload);
        const upstreamLogs = Array.isArray(raw.data && raw.data.logs) ? raw.data.logs : [];
        // Job logs are returned to the browser. Redact both known runtime
        // credentials/tokens and secret-shaped fields before caching or exposing
        // any upstream content.
        const logs = sanitizeForLog(upstreamLogs, this._secrets());
        return {
          logs,
          pagination: normalizeJobLogPagination(raw, page, size, logs.length),
        };
      },
      {
        bypassFresh: forceRefresh,
        flights: this.jobLogFlights,
        maxEntries: this.maxJobLogCacheEntries,
      }
    );
  }

  clearCaches() {
    this.scheduleCache.clear();
    this.scheduleDetailCache.clear();
    this.jobLogCache.clear();
    this.scheduleFlights.clear();
    this.scheduleDetailFlights.clear();
    this.jobLogFlights.clear();
  }
}

class ScheduleDirectoryError extends Error {
  constructor(message, { statusCode = 409, code = 'SCHEDULE_NOT_BINDABLE' } = {}) {
    super(message);
    this.name = 'ScheduleDirectoryError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

class ScheduleDirectory {
  constructor({ client, findBinding = null, listBindings = null } = {}) {
    if (!client) throw new TypeError('scheduleDirectory 需要 yingdao client');
    this.client = client;
    this.findBinding = findBinding;
    this.listBindings = listBindings;
  }

  async list(filters = {}) {
    const includeBound = filters.includeBound ?? filters.include_bound ?? false;
    const query = String(filters.query || '').trim().toLowerCase();
    const requestedPage = Number(filters.page) || 1;
    const requestedSize = Number(filters.size) || 20;
    const result = typeof this.client.fetchAllSchedules === 'function'
      ? await this.client.fetchAllSchedules({ size: 100 })
      : await this.client.listSchedules({ page: requestedPage, size: requestedSize });
    const bindings = this.listBindings
      ? await this.listBindings(result.schedules, filters)
      : [];
    const bindingMap = bindings instanceof Map
      ? bindings
      : new Map((Array.isArray(bindings) ? bindings : []).map(binding => [
          String(binding.scheduleUuid || binding.schedule_uuid),
          binding,
        ]));

    const filteredSchedules = result.schedules
      .map(schedule => {
        const scheduleUuid = String(schedule.scheduleUuid || schedule.schedule_uuid || '');
        const scheduleName = String(schedule.scheduleName || schedule.schedule_name || '');
        const binding = bindingMap.get(scheduleUuid) || null;
        return {
          schedule_uuid: scheduleUuid,
          schedule_name: scheduleName,
          bound: Boolean(binding),
          bound_task_id: binding && String(binding.taskId || binding.id || binding.rpaTaskId || ''),
          bound_task_name: binding && (binding.taskName || binding.task || ''),
          bound_owner: binding && (binding.owner || binding.ownerDisplayName || null),
        };
      })
      .filter(schedule => includeBound || query || !schedule.bound)
      .filter(schedule => !query
        || schedule.schedule_name.toLowerCase().includes(query)
        || schedule.schedule_uuid.toLowerCase().includes(query));
    const start = (requestedPage - 1) * requestedSize;
    const schedules = filteredSchedules.slice(start, start + requestedSize);
    return {
      schedules,
      page: {
        page: requestedPage,
        size: requestedSize,
        total: filteredSchedules.length,
        pages: Math.max(1, Math.ceil(filteredSchedules.length / requestedSize)),
      },
      cache: result.cache,
    };
  }

  async assertBindable(scheduleUuid, context = {}) {
    const result = await this.client.ensureScheduleExists(scheduleUuid);
    const resolver = context.findBinding || this.findBinding;
    const binding = resolver ? await resolver(String(scheduleUuid), context) : null;
    const currentTaskId = context.taskId ?? context.excludeTaskId;
    const boundTaskId = binding && (binding.taskId || binding.id || binding.rpaTaskId);
    if (binding && (!currentTaskId || String(boundTaskId) !== String(currentTaskId))) {
      throw new ScheduleDirectoryError('该 scheduleUuid 已绑定到其他任务', {
        code: 'SCHEDULE_ALREADY_BOUND',
      });
    }
    return { schedule: result.schedule, cache: result.cache, binding };
  }
}

class ExecutionDetails {
  constructor({ client, executionsRepository = null } = {}) {
    if (!client) throw new TypeError('executionDetails 需要 yingdao client');
    this.client = client;
    this.executionsRepository = executionsRepository;
  }

  async getJobs(taskUuid, { clients = null } = {}) {
    let resolvedClients = clients;
    if (!resolvedClients && this.executionsRepository) {
      const execution = await this.executionsRepository.findByTaskUuid(String(taskUuid));
      if (!execution) {
        const error = new Error('未找到该执行记录');
        error.name = 'ExecutionDetailsError';
        error.statusCode = 404;
        error.code = 'EXECUTION_NOT_FOUND';
        throw error;
      }
      resolvedClients = execution.clients;
    }
    const jobs = await this.client.getExecutionJobs(taskUuid, resolvedClients || []);
    const jobUuids = jobs
      .map(job => job && (job.jobUuid || job.job_uuid))
      .filter(Boolean)
      .map(String);
    if (
      jobUuids.length > 0
      && this.executionsRepository
      && typeof this.executionsRepository.mergeJobUuids === 'function'
    ) {
      await this.executionsRepository.mergeJobUuids(String(taskUuid), jobUuids);
    }
    return jobs;
  }

  async getLogs(jobUuid, options = {}) {
    const normalizedJobUuid = String(jobUuid || '').trim();
    const execution = this.executionsRepository
      && typeof this.executionsRepository.findByJobUuid === 'function'
      ? await this.executionsRepository.findByJobUuid(normalizedJobUuid, {
          currentUserId: options.currentUserId,
        })
      : null;
    if (!execution) {
      const error = new Error('未找到包含该 jobUuid 的执行记录');
      error.name = 'ExecutionDetailsError';
      error.statusCode = 404;
      error.code = 'JOB_NOT_FOUND';
      throw error;
    }
    const { currentUserId: _currentUserId, ...clientOptions } = options;
    const result = await this.client.getJobLogs(normalizedJobUuid, clientOptions);
    return {
      logs: result.logs || [],
      pagination: result.pagination || normalizeJobLogPagination({}, clientOptions.page, clientOptions.size, (result.logs || []).length),
      cache: result.cache || {},
    };
  }
}

function createYingdaoClient(options) {
  return new YingdaoClient(options);
}

function createScheduleDirectory(options) {
  return new ScheduleDirectory(options);
}

function createExecutionDetails(options) {
  return new ExecutionDetails(options);
}

module.exports = {
  DEFAULT_BASE_URL,
  YingdaoApiError,
  YingdaoClient,
  ScheduleDirectory,
  ScheduleDirectoryError,
  ExecutionDetails,
  createYingdaoClient,
  createScheduleDirectory,
  createExecutionDetails,
  redactSensitive,
  sanitizeForLog,
  calculateBackoffDelay,
  normalizePage,
  normalizeJobLogPagination,
};
