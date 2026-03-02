import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, QueryCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import { initTelemetryLogger } from '../../../../utils/telemetry-logger';

const STOCK_HOLDS_TABLE = process.env.STOCK_HOLDS_TABLE_NAME;
const ORDERS_TABLE = process.env.ORDERS_TABLE_NAME;
const OUTBOX_TABLE_NAME = process.env.OUTBOX_TABLE_NAME;

interface PaymentCapturedEvent {
  detail: {
    orderId: string;
    paymentId: string;
    amount: number;
    timestamp: string;
    collectorUserId?: string;
  };
}

/**
 * Confirm Stock Holds Lambda
 * 
 * PURPOSE: Move stock holds from RESERVED → CONFIRMED when payment is captured
 * 
 * TRIGGERED BY: payment.captured.v1 event
 * 
 * FLOW:
 * 1. Payment domain publishes payment.captured.v1 with orderId
 * 2. This lambda finds all RESERVED holds for that order
 * 3. Updates each hold: RESERVED → CONFIRMED (removes TTL)
 * 4. Publishes order.stock.confirmed.v1 so Product domain can finalize sale
 */
export const handler = async (event: PaymentCapturedEvent): Promise<any> => {
  initTelemetryLogger(event, { domain: 'order-domain', service: 'confirm-stock-holds' });
  console.log('========== CONFIRM STOCK HOLDS START ==========');

  const { orderId, paymentId, amount, timestamp } = event.detail;

  if (!STOCK_HOLDS_TABLE || !ORDERS_TABLE || !OUTBOX_TABLE_NAME) {
    console.error('Missing environment variables');
    throw new Error('Internal server error');
  }

  if (!orderId || !paymentId) {
    throw new Error('Missing orderId or paymentId in payment.captured event');
  }

  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const now = new Date().toISOString();

  try {
    // ========== STEP 1: GET ALL HOLDS FOR ORDER ==========
    console.log('Fetching holds for order:', { orderId });

    // Query holds by orderId (if GSI exists) or scan all and filter
    // For now, we'll do a simple approach - in production add GSI
    let holdsResult;
    try {
      // Try querying by orderId if GSI exists
      holdsResult = await client.send(
        new QueryCommand({
          TableName: STOCK_HOLDS_TABLE,
          IndexName: 'GSI1-OrderId', // GSI with orderId as PK
          KeyConditionExpression: 'orderId = :orderId',
          ExpressionAttributeValues: {
            ':orderId': orderId,
          },
        })
      );
    } catch (err: any) {
      // If GSI doesn't exist, get from order record
      console.log('GSI not available, getting holds from order record');
      const orderResult = await client.send(
        new GetCommand({
          TableName: ORDERS_TABLE,
          Key: { orderId },
        })
      );
      const order = orderResult.Item as Record<string, any> | undefined;
      if (!order || !order.stockHoldIds || order.stockHoldIds.length === 0) {
        throw new Error(`Order not found or has no holds: ${orderId}`);
      }

      // Fetch each hold individually
      const holds = [];
      for (const holdId of order.stockHoldIds) {
        const holdResult = await client.send(
          new GetCommand({
            TableName: STOCK_HOLDS_TABLE,
            Key: { holdId },
          })
        );
        if (holdResult.Item) {
          holds.push(holdResult.Item);
        }
      }
      holdsResult = { Items: holds };
    }

    const holds = (holdsResult.Items || []) as Record<string, any>[];
    console.log('Found holds:', { holdCount: holds.length });

    if (holds.length === 0) {
      throw new Error(`No holds found for order: ${orderId}`);
    }

    // ========== STEP 2: CONFIRM EACH HOLD ==========
    const confirmedHolds = [];

    for (const hold of holds) {
      console.log('Confirming hold:', { holdId: hold.holdId, status: hold.status });

      // Update hold: RESERVED → CONFIRMED (remove TTL)
      await client.send(
        new UpdateCommand({
          TableName: STOCK_HOLDS_TABLE,
          Key: { holdId: hold.holdId },
          UpdateExpression: 'SET #status = :status, paymentId = :paymentId, confirmedAt = :confirmedAt REMOVE expiresAt',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':status': 'CONFIRMED',
            ':paymentId': paymentId,
            ':confirmedAt': now,
          },
        })
      );

      confirmedHolds.push({
        holdId: hold.holdId,
        shelfItemId: hold.shelfItemId || hold.productId,
        quantity: hold.quantity,
        makerUserId: hold.makerUserId,
      });
    }

    console.log('Holds confirmed:', { confirmedCount: confirmedHolds.length });

    // ========== STEP 3: UPDATE ORDER STATUS (optional) ==========
    // Later: Could update order.status → PAID here, but better to do in separate handler
    // for now keep holds confirmation separate from order status

    // ========== STEP 4: QUEUE order.stock.confirmed.v1 EVENT ==========
    // This notifies Product Domain to finalize the sale (move qty from reserved → sold)
    try {
      const eventId = randomUUID();
      const correlationId = orderId;
      const traceId = randomUUID().replace(/-/g, '');
      const spanId = randomUUID().replace(/-/g, '').slice(0, 16);
      const expiresAtEpoch = Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60); // ✅ CRITICAL FIX: 7 days TTL (was 24h)
      const payload = {
        orderId,
        paymentId,
        holds: confirmedHolds,
        timestamp: now,
      };

      await client.send(
        new PutCommand({
          TableName: OUTBOX_TABLE_NAME,
          Item: {
            eventId,
            eventType: 'order.stock.confirmed.v1',
            eventVersion: 1,
            correlationId,
            payload: JSON.stringify(payload),
            status: 'PENDING',
            createdAt: now,
            retries: 0,
            trace_id: traceId,
            span_id: spanId,
            expiresAt: expiresAtEpoch,
          },
        })
      );
      console.log('order.stock.confirmed.v1 event queued', { orderId, eventId });
    } catch (err) {
      console.error('Failed to queue order.stock.confirmed event:', err);
    }

    return {
      success: true,
      orderId,
      paymentId,
      holdCount: confirmedHolds.length,
      confirmedAt: now,
    };
  } catch (err) {
    console.error('Confirm stock holds failed:', err);
    throw err;
  }
};
