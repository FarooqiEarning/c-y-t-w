# Use official Node.js LTS image (full version, not alpine)
FROM node:18

# Install FFmpeg and required system dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    git \
    python3 \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Clear npm cache and install dependencies
RUN npm cache clean --force && \
    npm install --verbose

# Copy source files
COPY . .

# Create temp directory and auth directory
RUN mkdir -p /tmp/whatsapp-videos && \
    mkdir -p /app/auth_info_baileys && \
    chmod -R 777 /tmp/whatsapp-videos && \
    chmod -R 777 /app/auth_info_baileys

# Set environment variables
ENV NODE_ENV=production
ENV PORT=5000

# Expose the application port
EXPOSE 5000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD node -e "require('http').get('http://localhost:5000/api/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start the application
CMD ["node", "index.js"]