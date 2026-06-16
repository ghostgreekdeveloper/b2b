FROM node:24-alpine

# Install openssl for Prisma
RUN apk add --no-cache openssl

WORKDIR /app

# Install ALL deps (including devDependencies needed for build)
COPY package.json package-lock.json* ./
RUN npm ci

# Copy source code
COPY . .

# Generate Prisma client
RUN npx prisma generate

# Set environment variables for build
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=4096"

# Build the application
RUN npm run build

# Remove devDependencies after build to shrink image
RUN npm prune --omit=dev && npm cache clean --force

EXPOSE 3000

# Start the application with database setup
CMD ["npm", "run", "docker-start"]
