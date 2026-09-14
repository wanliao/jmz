# 零第三方依赖：连 node_modules 都不需要，服务器上直接 node 启动
# 用 Node 24 LTS：内置 SQLite（node:sqlite）不需要额外装数据库
FROM node:24-alpine

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    TIME_ZONE=Asia/Shanghai \
    TZ=Asia/Shanghai \
    DB_FILE=/data/kimuzhi.db

COPY package.json ./
COPY shared ./shared
COPY server ./server
COPY public ./public
COPY config ./config
COPY scripts ./scripts

VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
