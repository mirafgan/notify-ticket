FROM mcr.microsoft.com/playwright:v1.55.1-noble AS deps

WORKDIR /app

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

FROM deps AS build

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM mcr.microsoft.com/playwright:v1.55.1-noble AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
  && npm cache clean --force

COPY --from=build /app/dist ./dist

RUN mkdir -p /data/browser-profile /data/artifacts \
  && chown -R pwuser:pwuser /app /data

USER pwuser

CMD ["xvfb-run", "-a", "node", "dist/telegram-bot.js"]
