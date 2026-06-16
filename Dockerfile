FROM node:24-alpine

# Install openssl for Prisma
RUN apk add --no-cache openssl

WORKDIR /app

# Install ALL deps
COPY package.json package-lock.json* ./
RUN npm ci

# Copy source
COPY . .

# Set environment variables for build
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=4096"

# Build the application
RUN npm run build

# Remove devDependencies after build
RUN npm prune --omit=dev && npm cache clean --force

EXPOSE 3000

CMD ["npm", "run", "docker-start"]
