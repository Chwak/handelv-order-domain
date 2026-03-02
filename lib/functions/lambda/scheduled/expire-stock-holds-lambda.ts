import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';

const STOCK_HOLDS_TABLE = process.env.STOCK_HOLDS_TABLE_NAME || '';
const OUTBOX_TABLE_NAME = process.env.OUTBOX_TABLE_NAME || '';

const dynamodbClient = new DynamoDBClient({});
const dynamodbDoc = DynamoDBDocumentClient.from(dynamodbClient);

interface StockHold {
  holdId: string;
  orderId: string;
  shelfItemId: string;
  quantity: number;
  status: string;
  collectorUserId: string;
  makerUserId: string;
  createdAt: string;
  expiresAt: number;
}

/**
 * Expire Stock Holds Lambda
 * 
 * Scheduled to run every 5 minutes to find expired RESERVED holds
 * and emit stock.hold.expired.v1 events for Product domain to restore inventory
 * 
 * This prevents inventory from being permanently locked by abandoned carts
 */
export const handler = async (): Promise<void> => {
  console.log('========== EXPIRE STOCK HOLDS START ==========');

  if (!STOCK_HOLDS_TABLE || !OUTBOX_TABLE_NAME) {
    console.error('Missing required environment variables');
    throw new Error('Internal server error');
  }

  const now = Math.floor(Date.now() / 1000);
  console.log('Current timestamp (epoch):', now);

  try {
    // Scan for expired RESERVED holds
    // In production, consider using a GSI on (status, expiresAt) for better performance
    const result = await dynamodbDoc.send(
      new ScanCommand({
        TableName: STOCK_HOLDS_TABLE,
        FilterExpression: '#status = :reserved AND expiresAt < :now',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':reserved': 'RESERVED',
          ':now': now,
        },
      })
    );

    const expiredHolds = (result.Items || []) as StockHold[];

    if (expiredHolds.length === 0) {
      console.log('No expired holds found');
      return;
    }

    console.log(`Found ${expiredHolds.length} expired holds to process`);

    let successCount = 0;
    let failureCount = 0;

    for (const hold of expiredHolds) {
      try {
        console.log(`Expiring hold: ${hold.holdId} for item ${hold.shelfItemId}`);

        // Update hold status to EXPIRED
        await dynamodbDoc.send(
          new UpdateCommand({
            TableName: STOCK_HOLDS_TABLE,
            Key: { holdId: hold.holdId },
            UpdateExpression: 'SET #status = :expired, expiredAt = :timestamp',
            ConditionExpression: '#status = :reserved', // Only expire if still RESERVED
            ExpressionAttributeNames: {
              '#status': 'status',
            },
            ExpressionAttributeValues: {
              ':expired': 'EXPIRED',
              ':reserved': 'RESERVED',
              ':timestamp': new Date().toISOString(),
            },
          })
        );

        // Emit stock.hold.expired.v1 event to Product domain
        const eventId = randomUUID();
        const traceId = randomUUID().replace(/-/g, '');
        const spanId = randomUUID().replace(/-/g, '').slice(0, 16);
        const expiresAtEpoch = Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60); // ✅ CRITICAL FIX: 7 days TTL (was 24h)

        await dynamodbDoc.send(
          new PutCommand({
            TableName: OUTBOX_TABLE_NAME,
            Item: {
              eventId,
              eventType: 'stock.hold.expired.v1',
              eventVersion: 1,
              correlationId: hold.holdId,
              payload: JSON.stringify({
                holdId: hold.holdId,
                shelfItemId: hold.shelfItemId,
                quantity: hold.quantity,
                collectorUserId: hold.collectorUserId,
                makerUserId: hold.makerUserId,
                orderId: hold.orderId,
                expiredAt: new Date().toISOString(),
              }),
              status: 'PENDING',
              createdAt: new Date().toISOString(),
              retries: 0,
              trace_id: traceId,
              span_id: spanId,
              expiresAt: expiresAtEpoch,
            },
          })
        );

        console.log(`Hold expired successfully: ${hold.holdId}, event queued: ${eventId}`);
        successCount++;
      } catch (err: any) {
        if (err.name === 'ConditionalCheckFailedException') {
          console.log(`Hold ${hold.holdId} was already updated (race condition), skipping`);
        } else {
          console.error(`Failed to expire hold ${hold.holdId}:`, err);
          failureCount++;
        }
      }
    }

    console.log(`Expiration complete: ${successCount} succeeded, ${failureCount} failed`);
  } catch (err) {
    console.error('Hold expiration failed:', err);
    throw err;
  }

  console.log('========== EXPIRE STOCK HOLDS END ==========');
};
