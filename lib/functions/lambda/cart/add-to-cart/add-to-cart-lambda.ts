import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { initTelemetryLogger } from '../../../../utils/telemetry-logger';
import { requireAuthenticatedUser, validateId, validateQuantity } from '../../../../utils/order-validation';

const CARTS_TABLE = process.env.CARTS_TABLE_NAME;
const SHELF_ITEMS_TABLE = process.env.SHELF_ITEMS_TABLE_NAME;
const CART_ITEM_IDEMPOTENCY_TABLE = process.env.CART_ITEM_IDEMPOTENCY_TABLE_NAME;
const CART_TTL_SECONDS = parseInt(process.env.CART_TTL_SECONDS || '3600', 10);

interface AddToCartRequest {
  cartId: string;
  collectorUserId: string;
  shelfItemId: string;
  quantity: number;
}

/**
 * Add to Cart Lambda
 * 
 * Adds or updates item in shopping cart with:
 * - Idempotency: ensures item not added twice
 * - Stock validation: verifies item exists and has stock
 * - Cart TTL: automatic cleanup after 1 hour
 */
export const handler = async (event: {
  arguments?: { input?: AddToCartRequest };
  identity?: any;
}): Promise<any> => {
  initTelemetryLogger(event, { domain: 'order-domain', service: 'add-to-cart' });

  if (!CARTS_TABLE || !SHELF_ITEMS_TABLE) {
    console.error('Missing required environment variable: CARTS_TABLE_NAME or SHELF_ITEMS_TABLE_NAME');
    throw new Error('Internal server error - misconfigured service');
  }

  const input = event.arguments?.input as AddToCartRequest | undefined;
  if (!input) {
    throw new Error('Missing add to cart input');
  }

  const { cartId, collectorUserId, shelfItemId, quantity } = input;

  const auth = requireAuthenticatedUser(event, 'collector');
  if (!auth) {
    throw new Error('Not authenticated');
  }

  const safeCartId = validateId(cartId);
  const safeCollectorId = validateId(collectorUserId);
  const safeShelfItemId = validateId(shelfItemId);
  const safeQuantity = validateQuantity(quantity, 1, 100);

  if (!safeCartId || !safeCollectorId || !safeShelfItemId || safeQuantity == null) {
    throw new Error('Missing or invalid fields');
  }
  if (auth !== safeCollectorId) {
    throw new Error('Forbidden');
  }

  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const now = new Date().toISOString();
  const nowEpoch = Math.floor(Date.now() / 1000);
  const cartTTL = nowEpoch + CART_TTL_SECONDS;

  try {
    // Validate shelf item exists
    const shelfResult = await client.send(
      new GetCommand({
        TableName: SHELF_ITEMS_TABLE,
        Key: { shelfItemId: safeShelfItemId },
      })
    );

    const shelfItem = shelfResult.Item as Record<string, any> | undefined;
    if (!shelfItem) {
      throw new Error('Shelf item not found');
    }

    if (shelfItem.isSoldOut === true || (shelfItem.quantityAvailable ?? 0) < quantity) {
      throw new Error('Insufficient stock');
    }

    const itemPrice = shelfItem.basePrice || 0;

    // Get or create cart
    const cartResult = await client.send(
      new GetCommand({
        TableName: CARTS_TABLE,
        Key: { cartId: safeCartId },
      })
    );

    let cartItems = [];
    let subtotal = 0;

    if (cartResult.Item) {
      const cart = cartResult.Item as any;
      if (cart.collectorUserId && cart.collectorUserId !== auth) {
        throw new Error('Forbidden');
      }
      cartItems = Array.isArray(cart.items) ? cart.items : [];
      subtotal = cart.subtotal || 0;
    }

    // Check if item already in cart (idempotency)
    const existingItemIndex = cartItems.findIndex(
      (item: any) => item.shelfItemId === safeShelfItemId
    );

    if (existingItemIndex >= 0) {
      // Update quantity
      subtotal -= cartItems[existingItemIndex].quantity * cartItems[existingItemIndex].price;
      cartItems[existingItemIndex].quantity = safeQuantity;
    } else {
      // Add new item
      cartItems.push({
        shelfItemId: safeShelfItemId,
        quantity: safeQuantity,
        price: itemPrice,
      });
    }

    // Recalculate subtotal
    subtotal = cartItems.reduce((sum: number, item: any) => sum + item.quantity * item.price, 0);

    // Update cart
    await client.send(
      new UpdateCommand({
        TableName: CARTS_TABLE,
        Key: { cartId: safeCartId },
        UpdateExpression:
          'SET items = :items, subtotal = :subtotal, lastModified = :now, expiresAt = :ttl, collectorUserId = :userId, createdAt = if_not_exists(createdAt, :now)',
        ExpressionAttributeValues: {
          ':items': cartItems,
          ':subtotal': subtotal,
          ':now': now,
          ':ttl': cartTTL,
          ':userId': safeCollectorId,
        },
      })
    );

    console.log('Item added to cart:', { cartId: safeCartId, shelfItemId: safeShelfItemId, quantity: safeQuantity, subtotal });

    return {
      success: true,
      cartId: safeCartId,
      itemCount: cartItems.length,
      subtotal,
      updatedAt: now,
    };
  } catch (err) {
    console.error('Add to cart failed:', err);
    throw err;
  }
};
