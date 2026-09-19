FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --include=optional && npm cache clean --force

COPY index.html ./
COPY public ./public
COPY src ./src
COPY server ./server
COPY scripts ./scripts
COPY .env.example ./
COPY deploy ./deploy

EXPOSE 5192

CMD ["node", "server/index.cjs"]
