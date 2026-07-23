# ===== 构建阶段 =====
FROM node:20-alpine AS build
WORKDIR /app

# 安装依赖（含 devDependencies，Vite 打包需要）
COPY package.json package-lock.json ./
RUN npm ci

# 复制源码并构建
COPY vite.config.js ./
COPY index.html ./
COPY src/ ./src/
RUN npm run build

# ===== 测试阶段（CI / 本地验证：docker build --target test .）=====
FROM build AS test
COPY vitest.config.js ./
COPY server.cjs ./
COPY server/ ./server/
COPY lib/ ./lib/
COPY scripts/ ./scripts/
COPY storage/ ./storage/
COPY test/ ./test/
RUN npm test

# ===== 生产阶段 =====
FROM node:20-alpine
WORKDIR /app

# 只复制运行时需要的文件
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json /app/package-lock.json ./
COPY server.cjs ./
COPY server/ ./server/
COPY lib/ ./lib/
COPY storage/ ./storage/

# 仅安装生产依赖
RUN npm ci --omit=dev

EXPOSE 3002

# 健康检查（利用 Node.js 内置 http 模块，无需额外安装 curl/wget）
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3002/api/health',(r)=>{process.exit(r.statusCode===200?0:1)})"

ENV NODE_ENV=production
ENV PORT=3002
ENV YINGDAO_BASE_URL=https://api.yingdao.com

USER node
CMD ["node", "server.cjs"]
