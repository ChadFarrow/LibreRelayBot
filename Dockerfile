# syntax=docker/dockerfile:1
#
# Two stages so the build toolchain doesn't ship in the runtime image. The `irc`
# package has optional native deps (iconv, node-icu-charset-detector) that need a
# compiler to even attempt installation.
FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Drop root. node:20 ships a `node` user at uid 1000, matching the uid the rest of
# this box's containers run as.
USER node
EXPOSE 3336
# libre-relay-bot.js, NOT boost-after-boost.js -- that sibling script is legacy and
# would monitor the wrong bot in the wrong channel.
CMD ["node", "libre-relay-bot.js"]
