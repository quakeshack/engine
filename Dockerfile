# Build stage — produces the Vite client bundle (dist/browser/) and dedicated server (dist/dedicated/)
FROM node:24-alpine AS builder

ARG GIT_COMMIT_SHA
ARG VITE_SIGNALING_URL=""
ARG VITE_CDN_URL_PATTERN=""
ARG VITE_GAME_DIR=""

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html ./index.html
COPY dedicated.mjs ./dedicated.mjs
COPY vite.config.mjs ./vite.config.mjs
COPY vite.config.dedicated.mjs ./vite.config.dedicated.mjs
COPY jsconfig.json ./jsconfig.json
COPY source ./source
COPY public ./public
COPY test ./test

ENV WORKERS_CI_COMMIT_SHA=${GIT_COMMIT_SHA}
ENV VITE_SIGNALING_URL=${VITE_SIGNALING_URL}
ENV VITE_CDN_URL_PATTERN=${VITE_CDN_URL_PATTERN}
ENV VITE_GAME_DIR=${VITE_GAME_DIR}

RUN npm run build:production && \
    npm run dedicated:build:production

# Test stage — keeps dev dependencies and test sources so CI can run regressions
FROM builder AS test

CMD ["npm", "run", "test:physics"]

# Production stage — dedicated server + web client host
FROM node:24-alpine

ARG GIT_COMMIT_SHA
ENV GIT_COMMIT_SHA=${GIT_COMMIT_SHA}

RUN addgroup -S quakeshack && adduser -S quakeshack -G quakeshack

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY data ./data

RUN chown -R quakeshack:quakeshack /app
USER quakeshack

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO /dev/null http://localhost:3000/ || exit 1

CMD ["npm", "run", "dedicated:start:production"]
