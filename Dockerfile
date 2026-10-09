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
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
