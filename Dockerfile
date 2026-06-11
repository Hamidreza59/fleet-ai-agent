# syntax=docker/dockerfile:1
FROM node:20-slim

ENV NODE_ENV=production \
    LLM_PROVIDER=openai-compatible \
    MCP_TRANSPORT=http \
    PORT=3000

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm install -g tsx

COPY tsconfig.json ./
COPY src ./src

EXPOSE 3000
CMD ["tsx", "src/index.ts"]
