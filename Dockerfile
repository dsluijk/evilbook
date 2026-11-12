# The client is built here; nothing from this stage reaches the final image except dist/.
FROM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN npm run build

# Node 22 strips TypeScript types natively, so the server runs from source with no
# build step and no TypeScript toolchain in the image. The only runtime dependency
# is `ws`.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY src/server ./src/server

USER node
EXPOSE 8080

CMD ["node", "src/server/index.ts"]
