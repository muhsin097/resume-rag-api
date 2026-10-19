# node:24-slim (Debian, glibc) rather than alpine -- avoids the classic
# Prisma-on-musl engine-binary headaches. Runtime queries go through the
# @prisma/adapter-pg driver adapter (no native query engine needed at all),
# but `prisma migrate deploy` at container start still needs the schema
# engine, so glibc keeps that path boring and reliable.

FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-slim AS build
WORKDIR /app
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

FROM node:24-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-slim AS runtime
WORKDIR /app
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./prisma.config.ts
COPY package.json ./

EXPOSE 3000

# Applies any pending migrations, then starts the API -- the ECS/ALB health
# check target is GET /health (see src/health), which only reports healthy
# once the app is actually serving traffic.
#
# The retry loop exists because the very first `migrate deploy` on a
# freshly-recreated container intermittently hits EACCES spawning the
# Prisma schema engine binary (a transient filesystem/exec-bit propagation
# issue on container start, not a missing file -- it's there and
# executable moments later). Docker Compose's restart policy was already
# recovering from this by restarting the whole container, which works but
# shows as a failed deploy and costs a full container recreation; retrying
# in place is faster and doesn't require external intervention to notice
# it even worked. `exec` on success replaces the shell with node directly;
# if every attempt fails, falls through to an explicit non-zero exit
# rather than silently starting the app with unapplied migrations (a bare
# `for ... done && node dist/main.js` would NOT catch that -- the loop's
# own exit status would come from the last `sleep`, not from prisma).
CMD ["sh", "-c", "for i in 1 2 3 4 5; do npx prisma migrate deploy && exec node dist/main.js; echo \"migrate deploy attempt $i failed, retrying in 3s...\" >&2; sleep 3; done; echo 'migrate deploy failed after 5 attempts' >&2; exit 1"]
