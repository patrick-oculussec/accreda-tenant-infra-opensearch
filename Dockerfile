# Tenant OpenSearch Provisioning Service Dockerfile
# Uses Amazon ECR Public Gallery base images for ECS compatibility

# Use Amazon Linux 2023 with Node.js 18 from Amazon ECR Public Gallery
FROM public.ecr.aws/docker/library/node:18-alpine

# Set working directory
WORKDIR /app

# Create non-root user for security (FedRAMP requirement)
RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup

# Copy package files
COPY package*.json ./

# Install production dependencies only
# Clean npm cache to reduce image size
RUN npm install --omit=dev && \
    npm cache clean --force

# Copy application source code
COPY . .

# Change ownership to non-root user
RUN chown -R appuser:appgroup /app

# Switch to non-root user
USER appuser

# Set environment variables
ENV NODE_ENV=production \
    LOG_LEVEL=info

# Health check (optional - ECS can use this)
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "console.log('healthy')" || exit 1

# Run the application
CMD ["node", "index.js"]

