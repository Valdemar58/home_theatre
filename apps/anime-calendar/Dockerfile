FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
# ffmpeg — кадры персонажей из своих серий (plot-frames.ts)
RUN apk add --no-cache ffmpeg
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=5056 HOSTNAME=0.0.0.0 DATA_DIR=/data
# Node 22 перебирает адреса хоста, давая каждому 250 мс на подключение: при медленной
# сети все попытки не успевают (ETIMEDOUT). Берём IPv4 и подключаемся без этого перебора
# node:sqlite в Node 22 помечен экспериментальным — предупреждение при каждом старте не нужно
ENV NODE_OPTIONS="--dns-result-order=ipv4first --no-network-family-autoselection --disable-warning=ExperimentalWarning"
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 5056
CMD ["node", "server.js"]
