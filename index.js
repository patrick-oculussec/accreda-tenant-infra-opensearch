/**
 * Tenant OpenSearch Provisioning Service
 * 
 * This service provisions OpenSearch Serverless collections for tenants.
 * It listens to an SQS queue for tenant creation events, creates the collection,
 * and updates the tenant record in the database.
 * 
 * Architecture:
 * 1. SQS Queue → Receives tenant provisioning requests
 * 2. OpenSearch Service → Creates serverless collections
 * 3. Database Service → Updates tenant records
 * 
 * Security & Compliance:
 * - IAM-based authentication for all AWS services
 * - RDS IAM authentication for database access
 * - Encryption at rest and in transit
 * - Comprehensive audit logging
 * - Meets FedRAMP security standards
 * 
 * Scalability:
 * - Containerized for ECS deployment
 * - Horizontal scaling via ECS task count
 * - Long-polling SQS for efficient message consumption
 * - Connection pooling for database efficiency
 */

require('dotenv').config();

const logger = require('./utils/logger');
const { initializeDatabase, closeDatabase } = require('./config/database');
const SQSService = require('./services/sqsService');
const OpenSearchService = require('./services/opensearchService');
const DatabaseService = require('./services/databaseService');

// Service instances
const sqsService = new SQSService();
const openSearchService = new OpenSearchService();
const databaseService = new DatabaseService();

/**
 * Processes a tenant provisioning message
 * 
 * @param {object} message - SQS message body
 * @param {string} message.tenant_id - Tenant UUID
 * @param {string} message.tenant_slug - Tenant slug
 * @param {string} message.timestamp - Message timestamp
 * @returns {Promise<void>}
 */
async function processTenantMessage(message) {
  const { tenant_id, tenant_slug, timestamp } = message;
  
  logger.info('Processing tenant provisioning request', {
    tenant_id,
    tenant_slug,
    timestamp
  });

  try {
    // Step 1: Validate tenant exists and is in correct state
    const tenant = await databaseService.getTenant(tenant_id);
    
    const validation = databaseService.validateTenantForProvisioning(tenant);
    if (!validation.isValid) {
      logger.warn('Tenant validation failed', {
        tenant_id,
        reason: validation.message
      });
      // Don't throw - this is a valid scenario (idempotency)
      return;
    }

    logger.info('Tenant validation passed, creating OpenSearch collection', {
      tenant_id,
      tenant_slug: tenant.slug
    });

    // Step 2: Create OpenSearch collection
    const collection = await openSearchService.createCollection(tenant_id, tenant.slug);
    
    logger.info('OpenSearch collection created', {
      tenant_id,
      collection_arn: collection.arn,
      collection_endpoint: collection.endpoint
    });

    // Step 3: Update tenant record in database
    await databaseService.updateTenantOpenSearch(tenant_id, collection.arn, 'ready');
    
    logger.info('Tenant provisioning completed successfully', {
      tenant_id,
      tenant_slug: tenant.slug,
      opensearch_arn: collection.arn
    });
  } catch (error) {
    logger.error('Failed to provision tenant', {
      tenant_id,
      tenant_slug,
      error: error.message,
      stack: error.stack
    });

    // Mark tenant as failed in database for visibility
    try {
      await databaseService.markTenantOpenSearchFailed(tenant_id, error.message);
    } catch (dbError) {
      logger.error('Failed to mark tenant as failed', {
        tenant_id,
        error: dbError.message
      });
    }

    // Re-throw to allow SQS message retry
    throw error;
  }
}

/**
 * Main application startup
 */
async function main() {
  logger.info('Starting Tenant OpenSearch Provisioning Service');
  logger.info('Environment', {
    nodeVersion: process.version,
    logLevel: process.env.LOG_LEVEL || 'info',
    region: 'us-east-1'
  });

  try {
    // Initialize database connection pool
    logger.info('Initializing database connection');
    await initializeDatabase();
    logger.info('Database initialized successfully');

    // Start SQS polling
    logger.info('Starting SQS message polling');
    await sqsService.startPolling(processTenantMessage);
  } catch (error) {
    logger.error('Fatal error in main process', {
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
}

/**
 * Graceful shutdown handler
 */
async function shutdown(signal) {
  logger.info(`Received ${signal}, starting graceful shutdown`);

  try {
    // Stop polling for new messages
    sqsService.stopPolling();
    
    // Wait a moment for in-flight processing to complete
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Close database connections
    await closeDatabase();
    
    logger.info('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown', { error: error.message });
    process.exit(1);
  }
}

// Register shutdown handlers
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', {
    error: error.message,
    stack: error.stack
  });
  // Exit and let container orchestrator restart
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled promise rejection', {
    reason: reason,
    promise: promise
  });
  // Exit and let container orchestrator restart
  process.exit(1);
});

// Start the application
main();

