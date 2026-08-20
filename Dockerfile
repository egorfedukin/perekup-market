FROM node:24-alpine

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY public ./public

RUN mkdir -p /data && chown -R node:node /app /data

ENV NODE_ENV=production
ENV PORT=4173
ENV PEREKUP_DATA_DIR=/data

USER node

EXPOSE 4173

CMD ["node", "server.js"]
