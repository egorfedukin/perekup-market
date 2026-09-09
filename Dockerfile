FROM node:24-alpine

WORKDIR /app

COPY package.json ./
COPY server.js s3-sync.js ./
COPY cosmetics.js economy.js vehicle-rules.js trade-rules.js inspection.js progression.js gameplay.js ./
COPY vehicle-catalog.tsv vehicle-production-years.json ./
COPY ["каталог-одежды-с-фото.json", "./"]
COPY public ./public

RUN node --check server.js && node --check s3-sync.js && node -e "for (const name of ['cosmetics','economy','vehicle-rules','trade-rules','inspection','progression','gameplay']) require('./' + name)"

RUN mkdir -p /data && chown -R node:node /app /data

# Container Apps Cloud.ru не запускает контейнеры от root; пользователь node имеет UID 1000
USER node

ENV NODE_ENV=production
ENV PORT=4173
ENV PEREKUP_DATA_DIR=/data

EXPOSE 4173

CMD ["node", "server.js"]
