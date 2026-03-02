import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import { initTelemetryLogger } from '../../../../utils/telemetry-logger';

const ORDERS_TABLE = process.env.ORDERS_TABLE_NAME;
const OUTBOX_TABLE_NAME = process.env.OUTBOX_TABLE_NAME;

interface PaymentCapturedEvent {
  detail: {
    orderId: string;
    paymentId: string;
    amount: number;
    timestamp: string;
  };
}

/**
 * Payment Captured Event Consumer Lambda
 * 
 * PURPOSE: Handle payment.captured.v1 events from Payment Domain
 * 
 * TRIGGERED BY: payment.captured.v1 event from EventBridge
 * 
 * ACTIONS:
 * 1. Transition order status: PENDING → PAID
 * 2. Record paymentId on order
 * 3. Publish order.paid.v1 event
 */
export const handler = async (event: PaymentCapturedEvent): Promise<any> => {
  initTelemetryLogger(event, { domain: 'order-domain', service: 'payment-captured-consumer' });
  console.log('========== PAYMENT CAPTURED EVENT RECEIVED ==========');

  const { orderId, paymentId, amount, timestamp } = event.detail;

  if (!ORDERS_TABLE || !OUTBOX_TABLE_NAME) {
    console.error('Missing environment variables');
    throw new Error('Internal server error');
  }

  if (!orderId || !paymentId) {
    throw new Error('Missing orderId or paymentId in payment event');
  }

  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const now = new Date().toISOString();

  try {
    // ========== STEP 1: GET ORDER ==========
    console.log('Fetching order:', { orderId });

    const orderResult = await client.send(
      new GetCommand({
        TableName: ORDERS_TABLE,
        Key: { orderId },
      })
    );

    const order = orderResult.Item as Record<string, any> | undefined;
    if (!order) {
      console.warn('Order not found, ignoring payment event:', { orderId });
      return { success: false, reason: 'Order not found' };
    }

    const currentStatus = order.status;
    console.log('Order found:', { orderId, currentStatus, totalAmount: order.totalAmount });

    // ========== STEP 2: VALIDATE STATUS & AMOUNT ==========
    if (currentStatus !== 'PENDING') {
      console.warn('Order not in PENDING status, ignoring payment:', { orderId, status: currentStatus });
      return { success: false, reason: 'Order not in PENDING status' };
    }

    if (order.totalAmount !== amount) {
      console.error('Payment amount mismatch:', { expected: order.totalAmount, received: amount });
      throw new Error(`Payment amount mismatch: expected ${order.totalAmount}, received ${amount}`);
    }

    // ========== STEP 3: UPDATE ORDER STATUS & RECORD PAYMENT ==========
    console.log('Updating order to PAID status');

    // Add paidAt timestamp to statusHistory
    const statusHistoryEntry = {
      status: 'PAID',
      timestamp: now,
      actor: 'system',
      reason: 'Payment captured',
    };

    await client.send(
      new UpdateCommand({
        TableName: ORDERS_TABLE,
        Key: { orderId },
        UpdateExpression: 'SET #status = :status, paymentId = :paymentId, paidAt = :paidAt, statusHistory = list_append(if_not_exists(statusHistory, :emptyList), :historyEntry), updatedAt = :updatedAt',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':status': 'PAID',
          ':paymentId': paymentId,
          ':paidAt': now,
          ':historyEntry': [statusHistoryEntry],
          ':emptyList': [],
          ':updatedAt': now,
        },
      })
    );

    console.log('Order status updated to PAID', { orderId, paymentId });

    // ========== STEP 4: QUEUE order.paid.v1 EVENT ==========
    try {
      const makerUserId = order.makerUserId as string | undefined;
      const makerUserIds = makerUserId ? [makerUserId] : [];

      const eventId = randomUUID();
      const correlationId = orderId;
      const traceId = randomUUID().replace(/-/g, '');
      const spanId = randomUUID().replace(/-/g, '').slice(0, 16);
      const expiresAtEpoch = Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60); // ✅ CRITICAL FIX: 7 days
      const payload = {
        orderId,
        paymentId,
        amount,
        collectorUserId: order.collectorUserId,
        makerUserId,
        makerUserIds,
        totalAmount: order.totalAmount,
        timestamp: now,
      };

      await client.send(
        new PutCommand({
          TableName: OUTBOX_TABLE_NAME,
          Item: {
            eventId,
            eventType: 'order.paid.v1',
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
      console.log('order.paid.v1 event queued', { orderId, eventId });
    } catch (err) {
      console.error('Failed to queue order.paid event:', err);
      // Don't fail if event publication fails
    }

    return {
      success: true,
      orderId,
      paymentId,
      paidAt: now,
    };
  } catch (err) {
    console.error('Payment captured consumer failed:', err);
    throw err;
  }
};
