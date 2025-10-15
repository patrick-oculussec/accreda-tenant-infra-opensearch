/**
 * Database Configuration with RDS IAM Authentication
 * 
 * This module handles PostgreSQL connections using AWS RDS IAM authentication.
 * Tokens are automatically generated and refreshed for each connection.
 * 
 * Security Features:
 * - IAM-based authentication (no static passwords)
 * - Automatic token rotation (15-minute expiration)
 * - Connection pooling with timeouts
 * - SSL/TLS encryption
 */

const { Pool } = require('pg');
const { Signer } = require('@aws-sdk/rds-signer');
const { defaultProvider } = require('@aws-sdk/credential-provider-node');
const logger = require('../utils/logger');

// Database configuration (hardcoded per FedRAMP requirements)
const DB_CONFIG = {
  region: 'us-east-1',
  hostname: 'accreda-pool-db-cluster-instance-1.cudoqm04qddr.us-east-1.rds.amazonaws.com',
  port: 5432,
  database: 'control_plane',
  username: 'accreda'
};

let pool = null;

/**
 * Generates a fresh IAM authentication token for RDS
 * Tokens are valid for 15 minutes
 * 
 * @returns {Promise<string>} IAM authentication token
 */
async function getFreshToken() {
  try {
    const signer = new Signer({
      region: DB_CONFIG.region,
      hostname: DB_CONFIG.hostname,
      port: DB_CONFIG.port,
      username: DB_CONFIG.username,
      credentialProvider: defaultProvider()
    });

    const token = await signer.getAuthToken();
    logger.debug('Generated fresh RDS IAM token');
    return token;
  } catch (error) {
    logger.error('Failed to generate RDS IAM token', { error: error.message });
    throw new Error(`RDS IAM token generation failed: ${error.message}`);
  }
}

/**
 * Initializes the database connection pool
 * Must be called before any database operations
 * 
 * @returns {Promise<void>}
 */
async function initializeDatabase() {
  if (pool) {
    logger.warn('Database pool already initialized');
    return;
  }

  try {
    logger.info('Initializing database connection pool');

    // Create pool configuration
    const poolConfig = {
      host: DB_CONFIG.hostname,
      port: DB_CONFIG.port,
      database: DB_CONFIG.database,
      user: DB_CONFIG.username,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 30000,
      statement_timeout: 30000,
      query_timeout: 30000,
      ssl: {
        rejectUnauthorized: false // Set to true in production with proper CA certificates
      }
    };

    pool = new Pool(poolConfig);

    // Override the connect method to inject fresh IAM tokens
    const originalConnect = pool.connect.bind(pool);
    pool.connect = async () => {
      // Generate fresh token for this connection
      const token = await getFreshToken();
      pool.options.password = token;
      
      return originalConnect();
    };

    // Setup error handling
    pool.on('error', (err) => {
      logger.error('Unexpected database pool error', { error: err.message });
    });

    // Test the connection
    const client = await pool.connect();
    try {
      const result = await client.query('SELECT NOW() as current_time, current_database()');
      logger.info('Database connection successful', {
        database: result.rows[0].current_database,
        timestamp: result.rows[0].current_time
      });
    } finally {
      client.release();
    }

    logger.info('Database pool initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize database pool', { error: error.message });
    throw error;
  }
}

/**
 * Executes a query with automatic connection management
 * 
 * @param {string} text - SQL query text
 * @param {Array} params - Query parameters
 * @returns {Promise<object>} Query result
 */
async function query(text, params) {
  if (!pool) {
    throw new Error('Database pool not initialized. Call initializeDatabase() first.');
  }

  const client = await pool.connect();
  try {
    const result = await client.query(text, params);
    return result;
  } finally {
    client.release();
  }
}

/**
 * Gets a client from the pool for transaction management
 * Caller must release the client when done
 * 
 * @returns {Promise<object>} Database client
 */
async function getClient() {
  if (!pool) {
    throw new Error('Database pool not initialized. Call initializeDatabase() first.');
  }

  return await pool.connect();
}

/**
 * Closes the database pool gracefully
 * Should be called on application shutdown
 * 
 * @returns {Promise<void>}
 */
async function closeDatabase() {
  if (pool) {
    logger.info('Closing database connection pool');
    await pool.end();
    pool = null;
    logger.info('Database pool closed');
  }
}

module.exports = {
  initializeDatabase,
  query,
  getClient,
  closeDatabase
};

