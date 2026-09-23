# Zero-dependency Node 22 app. Mount a volume at /data to keep the SQLite database.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
COPY data/sample ./data/sample
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/pricing.sqlite
VOLUME ["/data"]
EXPOSE 3000
USER node
CMD ["node", "--no-warnings=ExperimentalWarning", "server/index.js"]
