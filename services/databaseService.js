/**
 * Database Service
 * 
 * Handles database operations for updating tenant records with OpenSearch collection details.
 * Uses parameterized queries to prevent SQL injection.
 * 
 * Security Features:
 * - Parameterized queries for SQL injection prevention
 * - Transaction support for atomic updates
 * - Comprehensive error handling and logging
 */

const { query, getClient } = require('../config/database');
const logger = require('../utils/logger');

class DatabaseService {
  /**
   * Retrieves tenant information from the database
   * 
   * @param {string} tenantId - Tenant UUID
   * @returns {Promise<object|null>} Tenant record or null if not found
   */
  async getTenant(tenantId) {
    try {
      logger.debug('Fetching tenant from database', { tenantId });

      const result = await query(
        'SELECT id, slug, name, status, opensearch_arn, opensearch_status FROM public.accreda_tenants WHERE id = $1',
        [tenantId]
      );

      if (result.rows.length === 0) {
        logger.warn('Tenant not found', { tenantId });
        return null;
      }

      return result.rows[0];
    } catch (error) {
      logger.error('Failed to fetch tenant', { tenantId, error: error.message });
      throw error;
    }
  }

  /**
   * Validates that tenant is in a valid state for OpenSearch provisioning
   * 
   * @param {object} tenant - Tenant record
   * @returns {object} Validation result with isValid and message
   */
  validateTenantForProvisioning(tenant) {
    if (!tenant) {
      return { isValid: false, message: 'Tenant not found' };
    }

    if (tenant.status !== 'active') {
      return { isValid: false, message: `Tenant status is '${tenant.status}', expected 'active'` };
    }

    if (tenant.opensearch_arn) {
      logger.warn('Tenant already has OpenSearch collection', {
        tenantId: tenant.id,
        existingArn: tenant.opensearch_arn
      });
      return { isValid: false, message: 'Tenant already has an OpenSearch collection' };
    }

    if (tenant.opensearch_status === 'ready') {
      return { isValid: false, message: 'Tenant OpenSearch status is already ready' };
    }

    return { isValid: true, message: 'Tenant is valid for provisioning' };
  }

  /**
   * Updates tenant record with OpenSearch collection ARN and status
   * 
   * @param {string} tenantId - Tenant UUID
   * @param {string} opensearchArn - OpenSearch collection ARN
   * @param {string} status - OpenSearch status (default: 'ready')
   * @returns {Promise<object>} Updated tenant record
   */
  async updateTenantOpenSearch(tenantId, opensearchArn, status = 'ready') {
    const client = await getClient();
    
    try {
      logger.info('Updating tenant OpenSearch configuration', {
        tenantId,
        opensearchArn,
        status
      });

      // Start transaction for atomic update
      await client.query('BEGIN');

      // Update tenant record
      const updateResult = await client.query(
        `UPDATE public.accreda_tenants 
         SET opensearch_arn = $1, 
             opensearch_status = $2, 
             updated_at = NOW() 
         WHERE id = $3 
         RETURNING id, slug, name, opensearch_arn, opensearch_status, updated_at`,
        [opensearchArn, status, tenantId]
      );

      if (updateResult.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new Error('Tenant not found or update failed');
      }

      // Commit transaction
      await client.query('COMMIT');

      const updatedTenant = updateResult.rows[0];
      
      logger.info('Tenant OpenSearch configuration updated successfully', {
        tenantId: updatedTenant.id,
        tenantSlug: updatedTenant.slug,
        opensearchArn: updatedTenant.opensearch_arn,
        opensearchStatus: updatedTenant.opensearch_status
      });

      return updatedTenant;
    } catch (error) {
      // Rollback on error
      await client.query('ROLLBACK');
      
      logger.error('Failed to update tenant OpenSearch configuration', {
        tenantId,
        error: error.message,
        stack: error.stack
      });
      
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Updates tenant OpenSearch status to 'failed' in case of errors
   * 
   * @param {string} tenantId - Tenant UUID
   * @param {string} errorMessage - Error description
   * @returns {Promise<void>}
   */
  async markTenantOpenSearchFailed(tenantId, errorMessage) {
    try {
      logger.warn('Marking tenant OpenSearch as failed', { tenantId, errorMessage });

      await query(
        `UPDATE public.accreda_tenants 
         SET opensearch_status = $1, 
             updated_at = NOW() 
         WHERE id = $2`,
        ['failed', tenantId]
      );

      logger.info('Tenant OpenSearch status marked as failed', { tenantId });
    } catch (error) {
      logger.error('Failed to mark tenant OpenSearch as failed', {
        tenantId,
        error: error.message
      });
      // Don't throw - this is a best-effort operation
    }
  }
}

module.exports = DatabaseService;

