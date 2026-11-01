FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Субтитры ASS в плеере: worker и wasm libass (JASSUB) — файлами из public, сборщик их не трогает
RUN mkdir -p public/jassub && cp node_modules/jassub/dist/jassub-worker* node_modules/jassub/dist/default.woff2 public/jassub/
RUN npm run build

FROM deps AS runtime-deps
RUN npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
# ffmpeg — кадры персонажей из своих серий (plot-frames.ts) и звук серий; chromaprint (fpcalc) — отпечатки звука
# для поиска опенингов и эндингов (segments.ts)
RUN apk add --no-cache ffmpeg chromaprint postgresql-client
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=5056 HOSTNAME=0.0.0.0 DATA_DIR=/data
# Node 22 перебирает адреса хоста, давая каждому 250 мс на подключение: при медленной
# сети все попытки не успевают (ETIMEDOUT). Берём IPv4 и подключаемся без этого перебора
# node:sqlite в Node 22 помечен экспериментальным — предупреждение при каждом старте не нужно
ENV NODE_OPTIONS="--dns-result-order=ipv4first --no-network-family-autoselection --disable-warning=ExperimentalWarning"
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=runtime-deps /app/node_modules ./node_modules
COPY database ./database
COPY migrations ./migrations
EXPOSE 5056
CMD ["node", "database/start.mjs"]
