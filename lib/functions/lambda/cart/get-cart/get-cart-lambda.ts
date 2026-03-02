import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { initTelemetryLogger } from '../../../../utils/telemetry-logger';
import { requireAuthenticatedUser, validateId } from '../../../../utils/order-validation';

const CARTS_TABLE = process.env.CARTS_TABLE_NAME;

/**
 * Get Cart Lambda
 * 
 * Retrieves shopping cart contents
 */
export const handler = async (event: {
  arguments?: { cartId?: string };
  identity?: any;
}): Promise<any> => {
  initTelemetryLogger(event, { domain: 'order-domain', service: 'get-cart' });

  if (!CARTS_TABLE) {
    throw new Error('Internal server error');
  }

  const auth = requireAuthenticatedUser(event, 'collector');
  if (!auth) {
    throw new Error('Not authenticated');
  }

  const cartId = event.arguments?.cartId as string | undefined;
  const safeCartId = validateId(cartId);
  if (!safeCartId) {
    throw new Error('Missing cartId');
  }

  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  try {
    const result = await client.send(
      new GetCommand({
        TableName: CARTS_TABLE,
        Key: { cartId: safeCartId },
      })
    );

    if (!result.Item) {
      return {
        cartId: safeCartId,
        items: [],
        subtotal: 0,
        itemCount: 0,
      };
    }

    const cart = result.Item as any;
    if (cart.collectorUserId !== auth) {
      throw new Error('Forbidden');
    }

    return {
      cartId: safeCartId,
      collectorUserId: cart.collectorUserId,
      items: Array.isArray(cart.items) ? cart.items : [],
      subtotal: cart.subtotal || 0,
      itemCount: Array.isArray(cart.items) ? cart.items.length : 0,
      createdAt: cart.createdAt,
      lastModified: cart.lastModified,
    };
  } catch (err) {
    console.error('Get cart failed:', err);
    throw err;
  }
};
