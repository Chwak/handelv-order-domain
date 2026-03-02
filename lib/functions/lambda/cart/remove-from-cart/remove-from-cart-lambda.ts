import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { initTelemetryLogger } from '../../../../utils/telemetry-logger';
import { requireAuthenticatedUser, validateId } from '../../../../utils/order-validation';

const CARTS_TABLE = process.env.CARTS_TABLE_NAME;

interface RemoveFromCartRequest {
  cartId: string;
  shelfItemId: string;
}

/**
 * Remove from Cart Lambda
 * 
 * Removes item from shopping cart
 */
export const handler = async (event: {
  arguments?: { input?: RemoveFromCartRequest };
  identity?: any;
}): Promise<any> => {
  initTelemetryLogger(event, { domain: 'order-domain', service: 'remove-from-cart' });

  if (!CARTS_TABLE) {
    throw new Error('Internal server error');
  }

  const input = event.arguments?.input as RemoveFromCartRequest | undefined;
  if (!input) {
    throw new Error('Missing input');
  }

  const { cartId, shelfItemId } = input;

  const auth = requireAuthenticatedUser(event, 'collector');
  if (!auth) {
    throw new Error('Not authenticated');
  }

  const safeCartId = validateId(cartId);
  const safeShelfItemId = validateId(shelfItemId);

  if (!safeCartId || !safeShelfItemId) {
    throw new Error('Missing cartId or shelfItemId');
  }

  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const now = new Date().toISOString();

  try {
    // Get cart
    const cartResult = await client.send(
      new GetCommand({
        TableName: CARTS_TABLE,
        Key: { cartId: safeCartId },
      })
    );

    if (!cartResult.Item) {
      throw new Error('Cart not found');
    }

    const cart = cartResult.Item as any;
    if (cart.collectorUserId !== auth) {
      throw new Error('Forbidden');
    }
    let cartItems = Array.isArray(cart.items) ? cart.items : [];

    // Filter out item
    cartItems = cartItems.filter((item: any) => item.shelfItemId !== safeShelfItemId);

    // Recalculate subtotal
    const subtotal = cartItems.reduce((sum: number, item: any) => sum + item.quantity * item.price, 0);

    // Update cart
    if (cartItems.length === 0) {
      // Delete cart if empty
      await client.send(
        new UpdateCommand({
          TableName: CARTS_TABLE,
          Key: { cartId: safeCartId },
          UpdateExpression: 'SET items = :items, subtotal = :subtotal, lastModified = :now',
          ExpressionAttributeValues: {
            ':items': [],
            ':subtotal': 0,
            ':now': now,
          },
        })
      );
    } else {
      await client.send(
        new UpdateCommand({
          TableName: CARTS_TABLE,
          Key: { cartId: safeCartId },
          UpdateExpression: 'SET items = :items, subtotal = :subtotal, lastModified = :now',
          ExpressionAttributeValues: {
            ':items': cartItems,
            ':subtotal': subtotal,
            ':now': now,
          },
        })
      );
    }

    console.log('Item removed from cart:', { cartId: safeCartId, shelfItemId: safeShelfItemId });

    return {
      success: true,
      cartId: safeCartId,
      itemCount: cartItems.length,
      subtotal,
      updatedAt: now,
    };
  } catch (err) {
    console.error('Remove from cart failed:', err);
    throw err;
  }
};
