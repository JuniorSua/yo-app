# yo-core as a container, for running Yo on an always-on machine (Home PC mode).
# Build context: a folder containing core.mjs (apps/core/dist) and web/ (apps/web/dist).
#   docker build -t yo-core:<tag> -f Dockerfile <context>
# Run with network_mode: host and YO_HOST=127.0.0.1 so only the machine itself (and its SSH tunnel)
# can reach it; the agent's computer container can't.
FROM node:24-bookworm-slim
ENV NODE_ENV=production NODE_NO_WARNINGS=1 YO_CORE_MAIN=1 \
    YO_HOST=127.0.0.1 YO_PORT=7777 YO_DATA_DIR=/data YO_SECRETS=file \
    YO_COMPUTER_MODE=remote YO_WEB_DIST=/app/web \
    YO_CORE_PLACEMENT=home-pc YO_RUNNER_PLACEMENT=home-pc
WORKDIR /app
COPY core.mjs core.mjs.map* /app/
COPY web /app/web
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.YO_PORT||7777)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "/app/core.mjs"]
