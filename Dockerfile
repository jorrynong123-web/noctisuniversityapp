FROM node:18-slim
WORKDIR /app
RUN npm install -g pnpm@9
COPY . .
RUN pnpm install --no-frozen-lockfile
RUN pnpm --filter @workspace/api-server run build
EXPOSE 8080
CMD ["node", "artifacts/api-server/dist/index.mjs"]
