# syntax=docker/dockerfile:1.7
# yo-computer: the agent's own Linux PC (Xvfb + openbox + headed Chromium + x11vnc) and agentd.
# Multi-arch (linux/arm64 + linux/amd64). Build from the repo root:
#   docker compose build yo-computer      (or: docker buildx build -f computer/Dockerfile .)
ARG NODE_IMAGE=node:22-trixie-slim

FROM ${NODE_IMAGE} AS node

# ------------------------------------------------------------------ build stage
FROM ${NODE_IMAGE} AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/agentd/package.json apps/agentd/
RUN --mount=type=cache,id=yo-pnpm,target=/pnpm/store \
    pnpm install --filter "@yo/agentd..." --frozen-lockfile --ignore-scripts
COPY packages/contracts packages/contracts
COPY apps/agentd apps/agentd
RUN pnpm --filter @yo/agentd build
# Runtime bundle + production node_modules for the externals (node-pty compiled here for linux,
# claude-agent-sdk with its platform-specific native `claude` binary).
RUN --mount=type=cache,id=yo-npm,target=/root/.npm \
    mkdir -p /out \
 && cp apps/agentd/dist/*.js apps/agentd/dist/package.json /out/ \
 && cd /out \
 && npm install --omit=dev --no-audit --no-fund --no-package-lock \
 && rm -rf node_modules/@anthropic-ai/claude-agent-sdk-linux-*-musl \
           node_modules/node-pty/build/Release/obj.target node_modules/node-pty/build/Release/.deps \
           node_modules/node-pty/deps node_modules/node-pty/src \
           node_modules/node-pty/prebuilds node_modules/node-pty/third_party \
 && node -e "require('node-pty'); console.log('node-pty ok')"

# ------------------------------------------------------------------ runtime
FROM debian:trixie-slim
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 LC_ALL=C.UTF-8

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tini xvfb openbox chromium x11vnc xdotool scrot feh xclip x11-utils \
      fonts-noto-core fonts-noto-color-emoji fonts-liberation \
      ca-certificates curl git jq python3 python3-venv procps less nano unzip zstd \
      xdg-utils bash-completion tzdata \
 && rm -rf /var/lib/apt/lists/* /usr/share/doc/* /usr/share/man/* /var/cache/apt/*

# Node 22 (+ npm for global CLIs)
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && node --version && npm --version

# Provider CLIs + Playwright MCP (uses the system Chromium over CDP; no bundled browsers).
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install -g --no-audit --no-fund @openai/codex@0.159.2 @playwright/mcp@0.0.83 \
 && npm cache clean --force \
 && rm -rf /usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-*/vendor/*/codex-resources/voice \
 && codex --version \
 && codex app-server --help >/dev/null \
 && playwright-mcp --version

# Quiet, locked-down Chromium defaults. RestoreOnStartup=1 reopens the agent's tabs (and keeps
# session-only logins) after hibernate, restarts and updates.
RUN mkdir -p /etc/chromium/policies/managed \
 && printf '%s\n' '{' \
    '  "BrowserSignin": 0,' \
    '  "MetricsReportingEnabled": false,' \
    '  "PromotionalTabsEnabled": false,' \
    '  "DefaultBrowserSettingEnabled": false,' \
    '  "BackgroundModeEnabled": false,' \
    '  "PasswordManagerEnabled": false,' \
    '  "RestoreOnStartup": 1' \
    '}' > /etc/chromium/policies/managed/yo.json

# Non-root agent user; /data is the persistent volume.
RUN useradd --uid 1000 --user-group --home-dir /data/home --create-home --shell /bin/bash agent \
 && mkdir -p /data/home/agents /data/home/shared /data/accounts /data/profiles /opt/yo /tmp/.X11-unix \
 && chmod 1777 /tmp/.X11-unix \
 && chown -R agent:agent /data

COPY --from=build /out /opt/yo/agentd

# Verify the Claude Agent SDK can locate + run its bundled native binary; expose it as `claude`.
RUN cd /opt/yo/agentd \
 && CLAUDE_BIN="$(node -e "const r=require('node:module').createRequire('/opt/yo/agentd/node_modules/@anthropic-ai/claude-agent-sdk/'); console.log(r.resolve('@anthropic-ai/claude-agent-sdk-linux-'+process.arch+'/claude'))")" \
 && echo "claude binary: $CLAUDE_BIN" \
 && ln -s "$CLAUDE_BIN" /usr/local/bin/claude \
 && HOME=/tmp claude --version \
 && node -e "require('/opt/yo/agentd/node_modules/node-pty')" \
 && rm -rf /tmp/.claude* /tmp/*.json

ENV HOME=/data/home \
    NODE_ENV=production \
    DISABLE_AUTOUPDATER=1 \
    YO_AGENTD_DIR=/opt/yo/agentd \
    AGENTD_PORT=7801

USER agent
WORKDIR /data/home
VOLUME ["/data"]
EXPOSE 7801
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:7801/healthz || exit 1
ENTRYPOINT ["tini", "--"]
CMD ["node", "/opt/yo/agentd/agentd.js"]
