const { createConfig, ConfigError } = require('../server/config.cjs');
const { Client } = require('pg');

function validEnv(overrides = {}) {
  return {
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://app:password@db.example/pytaskgantt',
    AUTH_MODE: 'dev',
    SESSION_SECRET: 'development-secret',
    YINGDAO_ACCESS_KEY_ID: 'test-id',
    YINGDAO_ACCESS_KEY_SECRET: 'test-secret',
    ...overrides,
  };
}

describe('运行时配置', () => {
  it('既没有 DATABASE_URL 也没有完整 PG 配置时拒绝启动，且不接受文件存储配置替代', () => {
    const env = validEnv({ DATABASE_URL: '' });
    env.STORAGE_DRIVER = 'file';
    env.TASKS_FILE = 'tasks.json';
    expect(() => createConfig(env)).toThrowError(ConfigError);
    expect(() => createConfig(env)).toThrow(/DATABASE_URL/);
  });

  it('缺少 DATABASE_URL 时根据 PG 配置生成并安全编码连接串', () => {
    const config = createConfig(validEnv({
      DATABASE_URL: '',
      PGHOST: 'db.example',
      PGPORT: '5433',
      PGDATABASE: 'task board',
      PGUSER: 'app@team',
      PGPASSWORD: ' p@ss:/?#%汉字 ',
    }));

    const parsed = new Client({ connectionString: config.database.url }).connectionParameters;
    expect(parsed.host).toBe('db.example');
    expect(parsed.port).toBe(5433);
    expect(parsed.user).toBe('app@team');
    expect(parsed.password).toBe(' p@ss:/?#%汉字 ');
    expect(parsed.database).toBe('task board');
  });

  it('显式 DATABASE_URL 优先于拆分 PG 配置', () => {
    const config = createConfig(validEnv({
      PGHOST: 'ignored.example',
      PGPORT: '5433',
      PGDATABASE: 'ignored',
      PGUSER: 'ignored',
      PGPASSWORD: 'ignored',
    }));

    expect(config.database.url).toBe('postgresql://app:password@db.example/pytaskgantt');
  });

  it('拆分 PG 配置不完整时指出缺少的配置项', () => {
    expect(() => createConfig(validEnv({
      DATABASE_URL: '',
      PGHOST: 'db.example',
      PGPORT: '5432',
      PGDATABASE: 'pytaskgantt',
      PGUSER: '',
      PGPASSWORD: '',
    }))).toThrow(/PGUSER, PGPASSWORD/);
  });

  it('自动生成连接串时校验 PG 端口', () => {
    expect(() => createConfig(validEnv({
      DATABASE_URL: '',
      PGHOST: 'db.example',
      PGPORT: '70000',
      PGDATABASE: 'pytaskgantt',
      PGUSER: 'app',
      PGPASSWORD: 'secret',
    }))).toThrow(/PGPORT/);
  });

  it('拒绝 pg 连接串无法无损还原的数据库名', () => {
    expect(() => createConfig(validEnv({
      DATABASE_URL: '',
      PGHOST: 'db.example',
      PGPORT: '5432',
      PGDATABASE: 'task:production',
      PGUSER: 'app',
      PGPASSWORD: 'secret',
    }))).toThrow(/PGDATABASE/);
  });

  it('生产环境拒绝开发身份切换和通配 CORS', () => {
    expect(() => createConfig(validEnv({ NODE_ENV: 'production' }))).toThrow(/AUTH_MODE=dev/);
    expect(() => createConfig(validEnv({
      NODE_ENV: 'production',
      AUTH_MODE: 'feishu',
      SESSION_SECRET: 'a-secure-session-secret-with-more-than-32-characters',
    }))).toThrow(/CORS_ORIGIN/);
  });

  it('生产保留现有数据库连接兼容性，并可显式启用 verify-full', () => {
    const production = createConfig(validEnv({
      NODE_ENV: 'production',
      AUTH_MODE: 'feishu',
      CORS_ORIGIN: 'https://tasks.example.com',
      SESSION_SECRET: 'a-secure-session-secret-with-more-than-32-characters',
    }));
    expect(production.database.ssl).toEqual({
      mode: 'disable',
      rootCertPath: '',
      certPath: '',
      keyPath: '',
    });
    expect(production.session.secure).toBe(true);

    const tlsProduction = createConfig(validEnv({
      NODE_ENV: 'production',
      AUTH_MODE: 'feishu',
      CORS_ORIGIN: 'https://tasks.example.com',
      SESSION_SECRET: 'a-secure-session-secret-with-more-than-32-characters',
      PGSSLMODE: 'verify-full',
    }));
    expect(tlsProduction.database.ssl.mode).toBe('verify-full');
  });

  it('解析 PostgreSQL CA、双向 TLS 和 application_name，并拒绝冲突配置', () => {
    const config = createConfig(validEnv({
      DATABASE_URL: 'postgresql://app:password@db.example/pytaskgantt?sslmode=verify-full&application_name=url-app',
      PGSSLMODE: 'verify-full',
      PGSSLROOTCERT: '/run/secrets/postgres-ca.pem',
      PGSSLCERT: '/run/secrets/postgres-client.pem',
      PGSSLKEY: '/run/secrets/postgres-client.key',
      PGAPPNAME: 'ignored-because-url-is-explicit',
    }));
    expect(config.database.applicationName).toBe('url-app');
    expect(config.database.ssl).toEqual({
      mode: 'verify-full',
      rootCertPath: '/run/secrets/postgres-ca.pem',
      certPath: '/run/secrets/postgres-client.pem',
      keyPath: '/run/secrets/postgres-client.key',
    });

    expect(() => createConfig(validEnv({
      DATABASE_URL: 'postgresql://app:password@db.example/pytaskgantt?sslmode=require',
      PGSSLMODE: 'verify-full',
    }))).toThrow(/conflicts/);
    expect(() => createConfig(validEnv({
      PGSSLMODE: 'verify-full',
      PGSSLCERT: '/run/secrets/client.pem',
    }))).toThrow(/PGSSLCERT and PGSSLKEY/);
    expect(() => createConfig(validEnv({
      PGSSLMODE: 'verify-full',
      PGSSLROOTCERT: 'relative/ca.pem',
    }))).toThrow(/absolute path/);
  });

  it('CORS 白名单只接受精确 origin，生产环境只接受 HTTPS', () => {
    expect(() => createConfig(validEnv({
      CORS_ORIGIN: '*,https://tasks.example.com',
    }))).toThrow(/cannot combine/);
    expect(() => createConfig(validEnv({
      CORS_ORIGIN: 'https://tasks.example.com/path',
    }))).toThrow(/exact HTTP\(S\) origins/);
    expect(() => createConfig(validEnv({
      NODE_ENV: 'production',
      AUTH_MODE: 'feishu',
      CORS_ORIGIN: 'http://tasks.example.com',
      SESSION_SECRET: 'a-secure-session-secret-with-more-than-32-characters',
    }))).toThrow(/only HTTPS/);

    const config = createConfig(validEnv({
      CORS_ORIGIN: 'https://tasks.example.com/,https://tasks.example.com',
    }));
    expect(config.cors.origins).toEqual(['https://tasks.example.com']);
  });

  it('读取会话、影刀、同步和保留期配置', () => {
    const config = createConfig(validEnv({
      CORS_ORIGIN: 'https://tasks.example.com,https://admin.example.com',
      SESSION_MAX_AGE_SECONDS: '7200',
      YINGDAO_SYNC_INTERVAL_SECONDS: '90',
      EXECUTION_RETENTION_DAYS: '45',
      UI_REFRESH_SECONDS: '12',
    }));
    expect(config.database.url).toContain('pytaskgantt');
    expect(config.database.applicationName).toBe('pytaskgantt');
    expect(config.database.ssl.mode).toBe('disable');
    expect(config.cors.origins).toEqual(['https://tasks.example.com', 'https://admin.example.com']);
    expect(config.session.maxAgeSeconds).toBe(7200);
    expect(config.yingdao.syncIntervalSeconds).toBe(90);
    expect(config.retention.executionDays).toBe(45);
    expect(config.uiRefreshSeconds).toBe(12);
  });

  it('页面刷新周期不能低于前端支持的五秒', () => {
    expect(() => createConfig(validEnv({ UI_REFRESH_SECONDS: '4' }))).toThrow(/between 5/);
  });
});
