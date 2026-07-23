'use strict';

class RetentionService {
  constructor({
    executionsRepository,
    retentionDays = 30,
    intervalMs = 24 * 60 * 60 * 1000,
    now = () => new Date(),
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    logger = null,
  } = {}) {
    if (!executionsRepository || typeof executionsRepository.deleteExpired !== 'function') {
      throw new TypeError('retentionService 需要 executionsRepository.deleteExpired');
    }
    this.executionsRepository = executionsRepository;
    this.retentionDays = retentionDays;
    this.intervalMs = intervalMs;
    this.now = now;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.logger = logger;
    this.interval = null;
    this.cleanupFlight = null;
    this.state = {
      running: false,
      lastRunAt: null,
      lastDeleted: 0,
      lastError: null,
    };
  }

  getState() {
    return { ...this.state };
  }

  runCleanup() {
    if (this.cleanupFlight) return this.cleanupFlight;
    this.cleanupFlight = this._runCleanup()
      .finally(() => {
        this.cleanupFlight = null;
      });
    return this.cleanupFlight;
  }

  async _runCleanup() {
    this.state.running = true;
    try {
      const result = await this.executionsRepository.deleteExpired(this.retentionDays);
      const deleted = typeof result === 'number'
        ? result
        : Number(result && (result.deleted || result.rowCount)) || 0;
      const now = this.now();
      this.state.lastRunAt = (now instanceof Date ? now : new Date(now)).toISOString();
      this.state.lastDeleted = deleted;
      this.state.lastError = null;
      return { deleted, retentionDays: this.retentionDays };
    } catch (error) {
      this.state.lastError = String(error && error.message ? error.message : error);
      throw error;
    } finally {
      this.state.running = false;
    }
  }

  start({ runImmediately = true } = {}) {
    if (this.interval) return this;
    if (runImmediately) {
      Promise.resolve().then(() => this.runCleanup()).catch(error => {
        if (this.logger && typeof this.logger.warn === 'function') {
          this.logger.warn('执行记录保留期清理失败', { message: error.message });
        }
      });
    }
    this.interval = this.setIntervalFn(() => {
      this.runCleanup().catch(error => {
        if (this.logger && typeof this.logger.warn === 'function') {
          this.logger.warn('执行记录保留期清理失败', { message: error.message });
        }
      });
    }, this.intervalMs);
    return this;
  }

  stop() {
    if (this.interval) this.clearIntervalFn(this.interval);
    this.interval = null;
  }
}

function createRetentionService(options) {
  return new RetentionService(options);
}

module.exports = {
  RetentionService,
  createRetentionService,
};
