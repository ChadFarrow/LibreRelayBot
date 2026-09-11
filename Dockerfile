# syntax=docker/dockerfile:1
#
# Two stages so the build toolchain doesn't ship in the runtime image. The `irc`
# package has optional native deps (iconv, node-icu-charset-detector) that need a
# compiler to even attempt installation.
# Node 22, not 20, and this is load-bearing rather than housekeeping.
#
# nostr-tools' Relay.connect() needs a WebSocket. Node only exposes a global
# WebSocket from 21 onwards, and none of these bots depend on `ws` -- they were
# written against the host's Node 22 and relied on the built-in. On node:20 every
# relay connect fails instantly with no DNS or network involved: the bot reads
# the IRC line correctly, resolves the podcast GUID, then logs
# "Published to 0/5 relays" and drops the boost. Observed on the VPS 2026-09-11.
#
# The alternative is adding `ws` and calling useWebSocketImplementation(). Matching
# the Node the code already runs on in production is the smaller change.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Drop root. node:20 ships a `node` user at uid 1000, matching the uid the rest of
# this box's containers run as.
# The app writes its log file into the working directory, but WORKDIR created
# /app as root and COPY leaves it root-owned -- so as `node` every single log
# line fails with EACCES and prints a caught stack trace instead. Noise that
# buries real errors. stdout logging (what docker captures) is unaffected either
# way; this just stops the file writes failing.
RUN chown -R node:node /app

USER node
EXPOSE 3336
# libre-relay-bot.js, NOT boost-after-boost.js -- that sibling script is legacy and
# would monitor the wrong bot in the wrong channel.
CMD ["node", "libre-relay-bot.js"]
