# Tenant OpenSearch Provisioning Service

A secure, scalable microservice for provisioning Amazon OpenSearch Serverless collections for multi-tenant SaaS applications. This service automatically creates isolated OpenSearch collections when new tenants are onboarded.

## Overview

This service monitors an SQS FIFO queue for tenant provisioning requests, creates dedicated OpenSearch Serverless collections with appropriate security policies, and updates tenant records in the PostgreSQL database.

### Key Features

- **Automatic Provisioning**: Creates OpenSearch collections on-demand via SQS messages
- **Secure by Default**: 
  - IAM-based authentication for all AWS services
  - RDS IAM authentication (no static database passwords)
  - Encryption at rest and in transit
  - Network and data access policies
- **FedRAMP Compliant**: Meets federal security standards
- **Multi-Tenant Isolation**: Each tenant gets a dedicated OpenSearch collection
- **Fault Tolerant**: Graceful error handling with SQS message retry
- **Container-Ready**: Optimized for Amazon ECS deployment

## Architecture

```
┌─────────────┐       ┌──────────────────┐       ┌─────────────────┐
│  SQS FIFO   │──────>│  ECS Service     │──────>│   OpenSearch    │
│   Queue     │       │  (This Service)  │       │   Serverless    │
└─────────────┘       └──────────────────┘       └─────────────────┘
                              │
                              ▼
                      ┌──────────────────┐
                      │  RDS PostgreSQL  │
                      │  (IAM Auth)      │
                      └──────────────────┘
```

## Prerequisites

### AWS Resources Required

1. **SQS FIFO Queue**: `tenant-opensearch.fifo`
2. **RDS PostgreSQL Database**: With IAM authentication enabled
3. **ECR Repository**: For Docker image storage
4. **ECS Cluster**: For running the service
5. **IAM Role**: ECS task role with appropriate permissions

### IAM Permissions

The ECS task role must have the following permissions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes"
      ],
      "Resource": "arn:aws:sqs:us-east-1:625867133463:tenant-opensearch.fifo"
    },
    {
      "Effect": "Allow",
      "Action": [
        "aoss:CreateCollection",
        "aoss:CreateAccessPolicy",
        "aoss:CreateSecurityPolicy",
        "aoss:BatchGetCollection"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": "rds-db:connect",
      "Resource": "arn:aws:rds-db:us-east-1:625867133463:dbuser:*/accreda"
    }
  ]
}
```

## Configuration

### Database Configuration

The service uses **hardcoded** database configuration (not environment variables) for security:

- **Region**: `us-east-1`
- **Host**: `accreda-pool-db-cluster-instance-1.cudoqm04qddr.us-east-1.rds.amazonaws.com`
- **Port**: `5432`
- **Database**: `control_plane`
- **User**: `accreda`

Authentication uses RDS IAM tokens (automatically generated).

### SQS Message Format

Messages in the queue must have this JSON structure:

```json
{
  "tenant_id": "550e8400-e29b-41d4-a716-446655440000",
  "tenant_slug": "acme-corp",
  "timestamp": "2024-01-15T10:30:45.123Z"
}
```

### Environment Variables

Optional environment variables:

- `LOG_LEVEL`: Logging verbosity (default: `info`)
  - Options: `debug`, `info`, `warn`, `error`
- `NODE_ENV`: Environment mode (default: `production`)

## Installation

### Local Development

```bash
# Install dependencies
npm install

# Run the service
npm start

# Run with auto-reload (development)
npm run dev
```

### Docker Build

```bash
# Build the Docker image
docker build -t tenant-opensearch-service .

# Run locally
docker run -e LOG_LEVEL=debug tenant-opensearch-service
```

## Deployment

### AWS CodePipeline + ECS

This service includes a `buildspec.yml` for automated deployment via AWS CodePipeline.

#### Required Environment Variables in CodeBuild

- `AWS_ACCOUNT_ID`: Your AWS account ID
- `AWS_DEFAULT_REGION`: `us-east-1`
- `IMAGE_REPO_NAME`: ECR repository name
- `CONTAINER_NAME`: ECS container name

#### Deployment Steps

1. **Push code to repository** (CodeCommit, GitHub, etc.)
2. **CodePipeline triggers** automatically
3. **CodeBuild** builds Docker image using `buildspec.yml`
4. **Image pushed to ECR**
5. **ECS task definition updated** with new image
6. **ECS service updated** with rolling deployment

### Manual ECS Deployment

1. Build and push Docker image:
```bash
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <account-id>.dkr.ecr.us-east-1.amazonaws.com
docker build -t tenant-opensearch .
docker tag tenant-opensearch:latest <account-id>.dkr.ecr.us-east-1.amazonaws.com/tenant-opensearch:latest
docker push <account-id>.dkr.ecr.us-east-1.amazonaws.com/tenant-opensearch:latest
```

2. Update ECS service:
```bash
aws ecs update-service --cluster <cluster-name> --service tenant-opensearch-service --force-new-deployment
```

## Monitoring

### CloudWatch Logs

The service logs to CloudWatch with structured JSON logging:

```json
{
  "timestamp": "2024-01-15 10:30:45",
  "level": "info",
  "message": "Tenant provisioning completed successfully",
  "service": "tenant-opensearch",
  "tenant_id": "550e8400-e29b-41d4-a716-446655440000",
  "opensearch_arn": "arn:aws:aoss:us-east-1:..."
}
```

### Key Metrics to Monitor

- **SQS Message Age**: Should remain low (indicates processing speed)
- **SQS Messages Visible**: Should not accumulate (indicates backlog)
- **ECS CPU/Memory**: Should remain within limits
- **Database Connections**: Should remain stable
- **OpenSearch Collection Count**: Should match tenant count

### Health Checks

The Docker image includes a basic health check. For production, configure ECS health checks on the service.

## Database Schema

The service updates the `public.accreda_tenants` table:

```sql
UPDATE public.accreda_tenants 
SET 
  opensearch_arn = '<collection-arn>',
  opensearch_status = 'ready',
  updated_at = NOW()
WHERE id = '<tenant-id>';
```

### OpenSearch Status Values

- `initializing`: Default state (before provisioning)
- `ready`: Collection created and active
- `failed`: Provisioning failed (check logs)

## Security

### Authentication

- **AWS Services**: IAM role-based (ECS task role)
- **Database**: RDS IAM authentication (tokens auto-rotate every 15 minutes)
- **No Static Credentials**: All authentication uses temporary credentials

### Encryption

- **In Transit**: 
  - TLS for all AWS API calls
  - SSL for database connections
  - HTTPS for OpenSearch endpoints
- **At Rest**:
  - OpenSearch collections encrypted with AWS-managed keys
  - Database encryption at rest (RDS)

### Network Security

- **VPC**: Service runs in private subnets
- **Security Groups**: Restrict traffic to necessary ports only
- **OpenSearch Network Policies**: Control collection access

### Compliance

- **FedRAMP**: Meets security requirements
- **Audit Logging**: All actions logged to CloudWatch
- **Least Privilege**: IAM policies follow principle of least privilege

## Troubleshooting

### Service Not Processing Messages

1. **Check ECS Task Status**:
   ```bash
   aws ecs describe-tasks --cluster <cluster> --tasks <task-arn>
   ```

2. **Check CloudWatch Logs**:
   - Look for connection errors
   - Verify IAM permissions
   - Check for database errors

3. **Verify SQS Queue**:
   ```bash
   aws sqs get-queue-attributes --queue-url <queue-url> --attribute-names All
   ```

### Database Connection Failures

- **Verify RDS IAM authentication is enabled**
- **Check security groups** (ECS → RDS connectivity)
- **Verify ECS task role** has `rds-db:connect` permission
- **Check database user** has `rds_iam` role granted

### OpenSearch Creation Failures

- **Check ECS task role permissions** for OpenSearch Serverless
- **Verify region** matches service configuration (us-east-1)
- **Check CloudWatch logs** for detailed error messages
- **Verify AWS service limits** (collection limits per account)

### Message Not Deleted from Queue

- Message will be reprocessed after visibility timeout
- Check for errors in CloudWatch logs
- Verify message format is correct
- Ensure tenant validation passes

## Development

### Project Structure

```
.
├── config/
│   └── database.js          # RDS IAM authentication
├── services/
│   ├── sqsService.js        # SQS polling
│   ├── opensearchService.js # OpenSearch collection creation
│   └── databaseService.js   # Database operations
├── utils/
│   └── logger.js            # Winston logging
├── index.js                 # Main entry point
├── package.json             # Dependencies
├── Dockerfile               # Container definition
├── buildspec.yml            # CodeBuild configuration
└── README.md               # This file
```

### Adding New Features

1. Follow existing code structure and patterns
2. Use logger for all significant actions
3. Add comprehensive error handling
4. Update this README with new configuration
5. Test locally before deploying

### Code Style

- **Security**: Use parameterized queries, validate inputs
- **Logging**: Log at appropriate levels (debug, info, warn, error)
- **Error Handling**: Catch and log all errors with context
- **Documentation**: Add inline comments for complex logic

## Support

For issues or questions:

1. **Check CloudWatch Logs** first
2. **Review this README** and database authentication guide
3. **Verify IAM permissions** and AWS resource configuration
4. **Check AWS service health** in the region

## License

UNLICENSED - Proprietary software for Accreda

---

**Last Updated**: October 2025  
**Version**: 1.0.0  
**Maintained By**: Accreda Infrastructure Team

