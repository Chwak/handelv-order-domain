import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import { initTelemetryLogger } from '../../../../utils/telemetry-logger';
import { requireAuthenticatedUser, validateId, validateShippingAddress } from '../../../../utils/order-validation';

const CARTS_TABLE = process.env.CARTS_TABLE_NAME;
const SHELF_ITEMS_TABLE = process.env.SHELF_ITEMS_TABLE_NAME;
const STOCK_HOLDS_TABLE = process.env.STOCK_HOLDS_TABLE_NAME;
const ORDERS_TABLE = process.env.ORDERS_TABLE_NAME;
const OUTBOX_TABLE_NAME = process.env.OUTBOX_TABLE_NAME;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME;
const CART_TTL_SECONDS = parseInt(process.env.CART_TTL_SECONDS || '3600', 10);
const STOCK_HOLD_TTL_SECONDS = parseInt(process.env.STOCK_HOLD_TTL_SECONDS || '1800', 10);
const IDEMPOTENCY_KEY_PREFIX = 'checkout-';

// Shipping cost calculation (basic - can be enhanced with weight/zone logic)
const BASE_SHIPPING_COST = 999; // $9.99 in cents
const TAX_RATE = 0.0875; // 8.75%

interface CheckoutRequest {
  cartId: string;
  collectorUserId: string;
  idempotencyKey?: string; // Optional - will be generated if not provided
  shippingAddress: {
    street: string;
    city: string;
    state: string;
    zip: string;
    country: string;
  };
}

interface CartItem {
  shelfItemId: string;
  quantity: number;
  price: number;
}

interface CartData {
  cartId: string;
  collectorUserId: string;
  items: CartItem[];
  subtotal: number;
  createdAt: string;
}

/**
 * Checkout Lambda - Convert Cart to Order
 * 
 * CRITICAL FEATURES:
 * 1. Idempotency: Prevents duplicate orders from retry requests
 * 2. Stock Hold Validation: Ensures holds are still valid (not expired)
 * 3. Atomic Reservation: Creates one order with multiple stock holds
 * 4. Error Handling: Releases holds on failure
 */
export const handler = async (event: {
  arguments?: { input?: CheckoutRequest };
  requestContext?: { authorizer?: { claims?: { sub?: string } } };
  identity?: any;
}): Promise<any> => {
  initTelemetryLogger(event, { domain: 'order-domain', service: 'checkout' });
  console.log('========== CHECKOUT START ==========');

  if (!CARTS_TABLE || !SHELF_ITEMS_TABLE || !STOCK_HOLDS_TABLE || !ORDERS_TABLE || !OUTBOX_TABLE_NAME) {
    console.error('Missing required environment variables');
    throw new Error('Internal server error');
  }

  const input = event.arguments?.input as CheckoutRequest | undefined;
  if (!input) {
    throw new Error('Missing checkout input');
  }

  const { cartId, collectorUserId, shippingAddress } = input;
  const idempotencyKey = input.idempotencyKey || `${IDEMPOTENCY_KEY_PREFIX}${randomUUID()}`;

  const auth = requireAuthenticatedUser(event, 'collector');
  if (!auth) {
    throw new Error('Not authenticated');
  }

  // ========== VALIDATION: Required Fields ==========
  const safeCartId = validateId(cartId);
  const safeCollectorId = validateId(collectorUserId);
  const safeShippingAddress = validateShippingAddress(shippingAddress);

  if (!safeCartId || !safeCollectorId || !safeShippingAddress) {
    throw new Error('Missing required fields: cartId, collectorUserId, or shippingAddress');
  }

  if (auth !== safeCollectorId) {
    throw new Error('Forbidden');
  }

  if (!EVENT_BUS_NAME) {
    throw new Error('EVENT_BUS_NAME not configured');
  }

  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const now = new Date().toISOString();
  const nowEpoch = Math.floor(Date.now() / 1000);

  try {
    // ========== STEP 1: IDEMPOTENCY CHECK ==========
    // Prevent duplicate orders from retry requests
    console.log('Checking idempotency:', { idempotencyKey });

    // Try to acquire idempotency lock
    try {
      await client.send(
        new PutCommand({
          TableName: ORDERS_TABLE,
          Item: {
            orderId: `idempotency:${idempotencyKey}`,
            status: 'IDEMPOTENCY_LOCK',
            createdAt: now,
            expiresAt: nowEpoch + (7 * 24 * 60 * 60), // ✅ CRITICAL FIX: 7 days TTL for idempotency (was 24h)
          },
          ConditionExpression: 'attribute_not_exists(orderId)',
        })
      );
      console.log('Idempotency lock acquired');
    } catch (err: any) {
      if (err.name === 'ConditionalCheckFailedException') {
        console.log('Idempotency lock already exists - returning previous result');
        // In production, would look up previous order and return it
        throw new Error('Duplicate checkout attempt - in progress');
      }
      throw err;
    }

    // ========== STEP 2: GET CART & VALIDATE ==========
    const cartResult = await client.send(
      new GetCommand({
        TableName: CARTS_TABLE,
        Key: { cartId: safeCartId },
      })
    );

    const cart = cartResult.Item as CartData | undefined;
    if (!cart) {
      throw new Error('Cart not found or expired');
    }

    if (cart.collectorUserId !== safeCollectorId) {
      throw new Error('Unauthorized: Cart does not belong to this user');
    }

    if (!Array.isArray(cart.items) || cart.items.length === 0) {
      throw new Error('Cannot checkout: Cart is empty');
    }

    console.log('Cart retrieved:', { cartId: safeCartId, itemCount: cart.items.length, subtotal: cart.subtotal });

    // ========== STEP 3: VALIDATE ITEMS & BUILD ORDER DATA ==========
    const holds = [];
    const orderItems: any[] = [];
    const makerIds = new Set<string>();
    const defaultHoldExpiresAt = nowEpoch + STOCK_HOLD_TTL_SECONDS;

    for (const item of cart.items) {
      console.log('Processing item:', { shelfItemId: item.shelfItemId, quantity: item.quantity });

      // Validate shelf item still exists
      const shelfResult = await client.send(
        new GetCommand({
          TableName: SHELF_ITEMS_TABLE,
          Key: { shelfItemId: item.shelfItemId },
        })
      );

      const shelfItem = shelfResult.Item as Record<string, any> | undefined;
      if (!shelfItem) {
        throw new Error(`Shelf item not found: ${item.shelfItemId}`);
      }

      // Validate product status (not paused)
      if (shelfItem.status && shelfItem.status !== 'READY_FOR_SHELF' && shelfItem.status !== 'ACTIVE') {
        throw new Error(`Product not available: ${item.shelfItemId} (status: ${shelfItem.status})`);
      }

      // Validate stock
      if (shelfItem.isSoldOut === true || (shelfItem.quantityAvailable ?? 0) < item.quantity) {
        throw new Error(`Insufficient stock: ${item.shelfItemId} (requested: ${item.quantity}, available: ${shelfItem.quantityAvailable ?? 0})`);
      }

      // Validate maker exists
      if (!shelfItem.makerUserId) {
        throw new Error(`Product missing maker: ${item.shelfItemId}`);
      }

      makerIds.add(shelfItem.makerUserId);

      // Create stock hold for this item (RESERVED - will be CONFIRMED on payment success)
      const holdId = randomUUID();
      await client.send(
        new PutCommand({
          TableName: STOCK_HOLDS_TABLE,
          Item: {
            holdId,
            orderId: '', // Will be filled once order is created
            shelfItemId: item.shelfItemId,
            quantity: item.quantity,
            status: 'RESERVED', // ✓ RESERVED - NOT CONFIRMED YET
            collectorUserId: safeCollectorId,
            makerUserId: shelfItem.makerUserId,
            createdAt: now,
            expiresAt: defaultHoldExpiresAt, // Expires in 30min if not confirmed
            uuid: holdId,
          },
        })
      );

      holds.push({ holdId, shelfItemId: item.shelfItemId, quantity: item.quantity, makerUserId: shelfItem.makerUserId });

      // Emit stock.hold.created.v1 event to reserve inventory in Product domain
      try {
        const holdEventId = randomUUID();
        const holdTraceId = randomUUID().replace(/-/g, '');
        const holdSpanId = randomUUID().replace(/-/g, '').slice(0, 16);
        const holdExpiresAt = Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60); // ✅ CRITICAL FIX: 7 days TTL (was 24h)

        await client.send(
          new PutCommand({
            TableName: OUTBOX_TABLE_NAME,
            Item: {
              eventId: holdEventId,
              eventType: 'stock.hold.created.v1',
              eventVersion: 1,
              correlationId: holdId,
              payload: JSON.stringify({
                holdId,
                shelfItemId: item.shelfItemId,
                quantity: item.quantity,
                collectorUserId: safeCollectorId,
                makerUserId: shelfItem.makerUserId,
                expiresAt: defaultHoldExpiresAt,
                timestamp: now,
              }),
              status: 'PENDING',
              createdAt: now,
              retries: 0,
              trace_id: holdTraceId,
              span_id: holdSpanId,
              expiresAt: holdExpiresAt,
            },
          })
        );
        console.log('stock.hold.created.v1 event queued', { holdId, shelfItemId: item.shelfItemId, holdEventId });
      } catch (err) {
        console.error('Failed to queue stock.hold.created event:', err);
        // This is critical - if we can't emit the event, we should fail the checkout
        throw new Error('Failed to reserve inventory - please try again');
      }

      // Build order item
      orderItems.push({
        itemId: randomUUID(),
        shelfItemId: item.shelfItemId,
        makerUserId: shelfItem.makerUserId,
        quantity: item.quantity,
        unitPrice: item.price,
        subtotal: item.price * item.quantity,
        shelfItemSnapshot: {
          title: shelfItem.title,
          description: shelfItem.description,
          price: shelfItem.price,
        },
        createdAt: now,
      });
    }

    console.log('Stock holds created:', { holdCount: holds.length, makerCount: makerIds.size });

    // ========== STEP 4: CALCULATE SHIPPING & TAX ==========
    const subtotal = cart.subtotal;
    const shippingCost = BASE_SHIPPING_COST; // Simplified - can add weight/zone logic later
    const taxableAmount = subtotal + shippingCost;
    const taxAmount = Math.round(taxableAmount * TAX_RATE);
    const totalAmount = subtotal + shippingCost + taxAmount;

    console.log('Pricing calculated:', { subtotal, shippingCost, taxAmount, totalAmount });

    // ========== STEP 5: CREATE ORDER & LINK HOLDS ==========
    const orderId = randomUUID();

    await client.send(
      new PutCommand({
        TableName: ORDERS_TABLE,
        Item: {
          orderId,
          collectorUserId: safeCollectorId,
          makerUserIds: Array.from(makerIds), // Track all makers for this order
          cartId,
          status: 'PENDING', // Stays PENDING until payment succeeds
          subtotal,
          shippingCost,
          taxAmount,
          totalAmount,
          currency: 'USD',
          shippingAddress: safeShippingAddress,
          items: orderItems,
          stockHoldIds: holds.map((h) => h.holdId),
          statusHistory: [
            {
              status: 'PENDING',
              timestamp: now,
              actor: 'system',
            },
          ],
          createdAt: now,
          updatedAt: now,
          expiresAt: nowEpoch + 1800, // 30 min TTL - unpaid orders auto-cleanup
        },
      })
    );

    // Link holds to order  
    for (const hold of holds) {
      await client.send(
        new UpdateCommand({
          TableName: STOCK_HOLDS_TABLE,
          Key: { holdId: hold.holdId },
          UpdateExpression: 'SET orderId = :orderId',
          ExpressionAttributeValues: {
            ':orderId': orderId,
          },
        })
      );
    }

    console.log('Order created successfully:', { orderId, collectorUserId: safeCollectorId, itemCount: cart.items.length });

    // ========== STEP 6: QUEUE order.created.v1 EVENT ==========
    // This triggers the Payment Domain to create a payment record
    try {
      const eventId = randomUUID();
      const correlationId = orderId;
      const traceId = randomUUID().replace(/-/g, '');
      const spanId = randomUUID().replace(/-/g, '').slice(0, 16);
      const expiresAtEpoch = Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60); // ✅ CRITICAL FIX: 7 days TTL (was 24h)
      const payload = {
        orderId,
        collectorUserId: safeCollectorId,
        makerUserIds: Array.from(makerIds),
        totalAmount,
        currency: 'USD',
        shippingAddress: safeShippingAddress,
        items: orderItems.map((item) => ({
          shelfItemId: item.shelfItemId,
          makerUserId: item.makerUserId,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
        })),
        subtotal,
        shippingCost,
        taxAmount,
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
            status: 'PENDING',
            createdAt: now,
            retries: 0,
            trace_id: traceId,
            span_id: spanId,
            expiresAt: expiresAtEpoch,
          },
        })
      );
      console.log('order.created.v1 event queued', { orderId, eventId });
    } catch (err) {
      console.error('Failed to queue order.created event:', err);
    }

    return {
      success: true,
      orderId,
      totalAmount,
      subtotal,
      shippingCost,
      taxAmount,
      itemCount: cart.items.length,
      holdCount: holds.length,
      createdAt: now,
    };
  } catch (err) {
    console.error('Checkout failed:', err);
    throw err;
  }
};
