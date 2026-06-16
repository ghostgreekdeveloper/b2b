FROM node:24-alpine
RUN apk add --no-cache openssl

WORKDIR /app

# Install ALL deps (including devDeps needed for build)
COPY package.json package-lock.json* ./
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build

# Remove devDependencies after build to shrink image
RUN npm prune --omit=dev && npm cache clean --force

ENV NODE_ENV=production
EXPOSE 3000

# On startup: prisma generate + migrate deploy + start server
CMD ["npm", "run", "docker-start"]
