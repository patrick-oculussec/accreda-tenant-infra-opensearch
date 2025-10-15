/**
 * SQS Service
 * 
 * Handles polling messages from the tenant-opensearch SQS FIFO queue.
 * Implements long polling for efficient message consumption.
 * 
 * Security Features:
 * - Uses IAM role-based authentication
 * - Validates message structure before processing
 * - Handles message deletion only after successful processing
 */

const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = require('@aws-sdk/client-sqs');
const logger = require('../utils/logger');

const SQS_CONFIG = {
  region: 'us-east-1',
  queueUrl: 'https://sqs.us-east-1.amazonaws.com/625867133463/tenant-opensearch.fifo'
};

class SQSService {
  constructor() {
    this.client = new SQSClient({ region: SQS_CONFIG.region });
    this.queueUrl = SQS_CONFIG.queueUrl;
    this.isPolling = false;
  }

  /**
   * Validates the structure of an SQS message payload
   * 
   * @param {object} messageBody - Parsed message body
   * @returns {boolean} True if valid
   */
  validateMessage(messageBody) {
    if (!messageBody || typeof messageBody !== 'object') {
      logger.warn('Invalid message body: not an object');
      return false;
    }

    const requiredFields = ['tenant_id', 'tenant_slug', 'timestamp'];
    for (const field of requiredFields) {
      if (!messageBody[field]) {
        logger.warn(`Invalid message body: missing field '${field}'`);
        return false;
      }
    }

    // Validate UUID format for tenant_id
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(messageBody.tenant_id)) {
      logger.warn('Invalid tenant_id format', { tenant_id: messageBody.tenant_id });
      return false;
    }

    // Validate tenant_slug format (DNS-compatible)
    const slugRegex = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
    if (!slugRegex.test(messageBody.tenant_slug)) {
      logger.warn('Invalid tenant_slug format', { tenant_slug: messageBody.tenant_slug });
      return false;
    }

    return true;
  }

  /**
   * Receives messages from the SQS queue
   * Uses long polling (20 seconds) for efficiency
   * 
   * @returns {Promise<Array>} Array of messages
   */
  async receiveMessages() {
    try {
      const command = new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: 1, // Process one tenant at a time for safety
        WaitTimeSeconds: 20, // Long polling
        VisibilityTimeout: 300, // 5 minutes to process
        MessageAttributeNames: ['All']
      });

      const response = await this.client.send(command);
      
      if (!response.Messages || response.Messages.length === 0) {
        return [];
      }

      logger.info(`Received ${response.Messages.length} message(s) from SQS`);
      return response.Messages;
    } catch (error) {
      logger.error('Failed to receive messages from SQS', { error: error.message });
      throw error;
    }
  }

  /**
   * Deletes a message from the queue after successful processing
   * 
   * @param {string} receiptHandle - Message receipt handle
   * @returns {Promise<void>}
   */
  async deleteMessage(receiptHandle) {
    try {
      const command = new DeleteMessageCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: receiptHandle
      });

      await this.client.send(command);
      logger.info('Message deleted from SQS queue');
    } catch (error) {
      logger.error('Failed to delete message from SQS', { error: error.message });
      throw error;
    }
  }

  /**
   * Starts polling the SQS queue
   * Processes messages using the provided handler function
   * 
   * @param {Function} messageHandler - Async function to process messages
   * @returns {Promise<void>}
   */
  async startPolling(messageHandler) {
    this.isPolling = true;
    logger.info('Starting SQS polling');

    while (this.isPolling) {
      try {
        const messages = await this.receiveMessages();

        for (const message of messages) {
          try {
            // Parse message body
            const messageBody = JSON.parse(message.Body);
            
            logger.info('Processing SQS message', {
              messageId: message.MessageId,
              tenant_id: messageBody.tenant_id,
              tenant_slug: messageBody.tenant_slug
            });

            // Validate message structure
            if (!this.validateMessage(messageBody)) {
              logger.error('Invalid message structure, deleting message', {
                messageId: message.MessageId
              });
              await this.deleteMessage(message.ReceiptHandle);
              continue;
            }

            // Process the message
            await messageHandler(messageBody);

            // Delete message after successful processing
            await this.deleteMessage(message.ReceiptHandle);
            
            logger.info('Message processed successfully', {
              messageId: message.MessageId,
              tenant_id: messageBody.tenant_id
            });
          } catch (error) {
            logger.error('Error processing message', {
              messageId: message.MessageId,
              error: error.message,
              stack: error.stack
            });
            // Message will become visible again after VisibilityTimeout
            // Consider implementing a dead-letter queue for persistent failures
          }
        }
      } catch (error) {
        logger.error('Error in polling loop', { error: error.message });
        // Wait before retrying to avoid tight error loops
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }

    logger.info('SQS polling stopped');
  }

  /**
   * Stops the polling loop gracefully
   */
  stopPolling() {
    logger.info('Stopping SQS polling');
    this.isPolling = false;
  }
}

module.exports = SQSService;

