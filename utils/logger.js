/**
 * Centralized logging utility using Winston
 * 
 * Provides structured logging with different levels for development and production.
 * Logs are formatted for CloudWatch compatibility.
 */

const winston = require('winston');

const logLevel = process.env.LOG_LEVEL || 'info';

const logger = winston.createLogger({
  level: logLevel,
  format: winston.format.combine(
    winston.format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss'
    }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  ),
  defaultMeta: { service: 'tenant-opensearch' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ level, message, timestamp, ...metadata }) => {
          let msg = `${timestamp} [${level}]: ${message}`;
          if (Object.keys(metadata).length > 0) {
            // Remove service from metadata to avoid duplication since it's in defaultMeta
            const { service, ...logMetadata } = metadata;
            if (Object.keys(logMetadata).length > 0) {
              msg += ` ${JSON.stringify(logMetadata)}`;
            }
          }
          return msg;
        })
      )
    })
  ]
});

module.exports = logger;

