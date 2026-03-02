import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import { initTelemetryLogger } from "../../../../utils/telemetry-logger";
import {
  requireAuthenticatedUser,
  validateId,
  validateQuantity,
  validateShippingAddress,
  type ShippingAddressInput,
} from '../../../../utils/order-validation';

function resolveTraceparent(event: { headers?: Record<string, string> }): string {
  const headerTraceparent = event.headers?.traceparent || event.headers?.Traceparent;
  const isValid = headerTraceparent && /^\d{2}-[0-9a-f]{32}-[0-9a-f]{16}-\d{2}$/i.test(headerTraceparent);
  if (isValid) return headerTraceparent;
  const traceId = randomUUID().replace(/-/g, '');
  const spanId = randomUUID().replace(/-/g, '').slice(0, 16);
  return `00-${traceId}-${spanId}-01`;
}

const ORDERS_TABLE = process.env.ORDERS_TABLE_NAME;
const ORDER_ITEMS_TABLE = process.env.ORDER_ITEMS_TABLE_NAME;
const STOCK_HOLDS_TABLE = process.env.STOCK_HOLDS_TABLE_NAME;
const SHELF_ITEMS_TABLE = process.env.SHELF_ITEMS_TABLE_NAME; // Read-only from Discovery
const OUTBOX_TABLE_NAME = process.env.OUTBOX_TABLE_NAME;

interface CreateOrderInput {
  collectorUserId?: unknown;
  makerUserId?: unknown;
  productId?: unknown;
  quantity?: unknown;
  shippingAddress?: ShippingAddressInput;
}

export const handler = async (event: {
  arguments?: { input?: CreateOrderInput };
  identity?: { sub?: string; claims?: { sub?: string } };
  headers?: Record<string, string>;
}) => {
  initTelemetryLogger(event, { domain: "order-domain", service: "create-order" });
  const traceparent = resolveTraceparent(event);
  if (!ORDERS_TABLE || !ORDER_ITEMS_TABLE || !STOCK_HOLDS_TABLE || !SHELF_ITEMS_TABLE || !OUTBOX_TABLE_NAME) {
    throw new Error('Internal server error');
  }

  const input = event.arguments?.input ?? {};
  const collectorUserId = validateId(input.collectorUserId);
  const makerUserId = validateId(input.makerUserId);
  const productId = validateId(input.productId);
  const quantity = validateQuantity(input.quantity, 1, 100);
  const shippingAddress = validateShippingAddress(input.shippingAddress);

  if (!collectorUserId || !makerUserId || !productId || quantity == null || !shippingAddress) {
    throw new Error('Invalid input format');
  }
  if (makerUserId === collectorUserId) throw new Error('makerUserId cannot equal collectorUserId');

  const auth = requireAuthenticatedUser(event, 'collector');
  if (!auth || auth !== collectorUserId) throw new Error('Forbidden');

  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const now = new Date().toISOString();

  // Step 1: Validate shelf item exists and get current quantity
  console.log('Validating shelf item:', { productId });
  const shelfItemResult = await client.send(
    new GetCommand({
      TableName: SHELF_ITEMS_TABLE,
      Key: { shelfItemId: productId },
    })
  );
  
  const shelfItem = shelfItemResult.Item as Record<string, any> | undefined;
  if (!shelfItem) {
    throw new Error('Shelf item not found or out of stock');
  }

  if (typeof shelfItem.makerUserId === 'string' && shelfItem.makerUserId !== makerUserId) {
    throw new Error('Invalid makerUserId for product');
  }

  if (shelfItem.shelfStatus !== 'ACTIVE') {
    throw new Error('Shelf item is no longer available');
  }

  if (shelfItem.isSoldOut === true || (shelfItem.quantityAvailable ?? 0) < quantity) {
    throw new Error('Insufficient stock available');
  }

  // Step 2: Try to create stock hold (atomic check-and-hold)
  console.log('Attempting to hold stock:', { productId, quantity });
  const holdId = randomUUID();
  const holdExpiresAt = Math.floor(Date.now() / 1000) + 1800; // 30 minutes TTL
  
  try {
    // Put hold with condition that item still has enough quantity
    await client.send(
      new PutCommand({
        TableName: STOCK_HOLDS_TABLE,
        Item: {
          holdId,
          orderId: '', // Will be filled once order is created
          productId,
          quantity,
          status: 'RESERVED',
          collectorUserId,
          makerUserId,
          createdAt: now,
          expiresAt: holdExpiresAt, // TTL cleanup
          uuid: holdId, // For idempotency
        },
      })
    );
  } catch (err) {
    console.error('Failed to create stock hold:', err);
    throw new Error('Unable to reserve stock at this time');
  }

  // Step 3: Create order records
  const orderId = randomUUID();
  const itemId = randomUUID();
  const unitPrice = shelfItem.basePrice || 0;
  const totalAmount = unitPrice * quantity;

  console.log('Creating order:', { orderId, collectorUserId, makerUserId, productId, quantity });

  try {
    // Create order
    await client.send(
      new PutCommand({
        TableName: ORDERS_TABLE,
        Item: {
          orderId,
          collectorUserId,
          makerUserId,
          productId,
          status: 'PENDING',
          totalAmount,
          shippingAddress: {
            street: shippingAddress.street,
            city: shippingAddress.city,
            state: shippingAddress.state,
            zip: shippingAddress.zip,
            country: shippingAddress.country,
          },
          createdAt: now,
          updatedAt: now,
        },
      })
    );

    // Create order item
    const orderItem = {
      orderId,
      itemId,
      productId,
      quantity,
      unitPrice,
      productSnapshot: {
        title: shelfItem.title || 'Product',
        description: shelfItem.description || '',
        makerName: shelfItem.makerUserId || '',
        basePrice: unitPrice,
      },
      createdAt: now,
    };

    await client.send(
      new PutCommand({
        TableName: ORDER_ITEMS_TABLE,
        Item: orderItem,
      })
    );

    // Update hold to link to order
    await client.send(
      new UpdateCommand({
        TableName: STOCK_HOLDS_TABLE,
        Key: { holdId },
        UpdateExpression: 'SET orderId = :orderId, #status = :status',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':orderId': orderId,
          ':status': 'CONFIRMED',
        },
      })
    );

    console.log('Order created successfully:', { orderId, holdId });

    // Write order.created.v1 to outbox for schema-validated republish
    try {
      const eventId = randomUUID();
      const correlationId = orderId;
      const traceId = randomUUID().replace(/-/g, '');
      const spanId = randomUUID().replace(/-/g, '').slice(0, 16);
      const expiresAtEpoch = Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60); // ✅ CRITICAL FIX: 7 days TTL (was 24h)
      const payload = {
        orderId,
        collectorUserId,
        makerUserId,
        makerUserIds: [makerUserId],
        totalAmount,
        currency: 'USD',
        shippingAddress,
        items: [
          {
            shelfItemId: productId,
            makerUserId,
            quantity,
            unitPrice,
          },
        ],
        subtotal: totalAmount,
        shippingCost: 0,
        taxAmount: 0,
        timestamp: now,
      };

      await client.send(
        new PutCommand({
          TableName: OUTBOX_TABLE_NAME,
          Item: {
            eventId,
            eventType: 'order.created.v1',
            eventVersion: 1,
            correlationId,
            payload: JSON.stringify(payload),
            traceparent,
            trace_id: traceId,
            span_id: spanId,
            status: 'PENDING',
            createdAt: now,
            retries: 0,
            expiresAt: expiresAtEpoch,
          },
        })
      );
      console.log('order.created.v1 event queued', { orderId, eventId });
    } catch (err) {
      console.error('Failed to queue order.created event:', err);
    }

    return {
      orderId,
      collectorUserId,
      makerUserId,
      productId,
      status: 'PENDING',
      totalAmount,
      shippingAddress: {
        street: shippingAddress.street,
        city: shippingAddress.city,
        state: shippingAddress.state,
        zip: shippingAddress.zip,
        country: shippingAddress.country,
      },
      items: [orderItem],
      createdAt: now,
      updatedAt: now,
    };
  } catch (err) {
    console.error('Failed to create order, releasing hold:', err);
    // Release the hold if order creation fails
    try {
      await client.send(
        new UpdateCommand({
          TableName: STOCK_HOLDS_TABLE,
          Key: { holdId },
          UpdateExpression: 'SET #status = :status',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':status': 'RELEASED' },
        })
      );
    } catch (releaseErr) {
      console.error('Failed to release hold:', releaseErr);
    }
    throw err;
  }
};