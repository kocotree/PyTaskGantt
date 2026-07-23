class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

class AuthenticationError extends AppError {
  constructor(message = '请先登录') {
    super(401, 'AUTH_REQUIRED', message);
  }
}

class AuthorizationError extends AppError {
  constructor(message = '无权执行此操作') {
    super(403, 'FORBIDDEN', message);
  }
}

class NotFoundError extends AppError {
  constructor(message = '资源不存在') {
    super(404, 'NOT_FOUND', message);
  }
}

class ConflictError extends AppError {
  constructor(code = 'CONFLICT', message = '数据已发生变化，请刷新后重试', details) {
    super(409, code, message, details);
  }
}

class ValidationError extends AppError {
  constructor(message = '请求数据不正确', details) {
    super(400, 'VALIDATION_ERROR', message, details);
  }
}

function databaseError(error) {
  if (error instanceof AppError) return error;
  if (error && ['22P02', '22003'].includes(error.code)) {
    return new ValidationError('ID 或数值参数格式不正确');
  }
  if (error && error.code === '23505') {
    if (String(error.constraint || '').includes('schedule')) {
      return new ConflictError('SCHEDULE_ALREADY_BOUND', '该影刀计划已被其他任务绑定');
    }
    return new ConflictError('UNIQUE_CONFLICT', '数据与现有记录冲突');
  }
  if (error && ['40001', '40P01'].includes(error.code)) {
    return new ConflictError('TRANSACTION_CONFLICT', '并发操作发生冲突，请重试');
  }
  return error;
}

module.exports = {
  AppError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ConflictError,
  ValidationError,
  databaseError,
};
