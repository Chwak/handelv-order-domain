import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import { initTelemetryLogger } from '../../../../utils/telemetry-logger';
import { requireAuthenticatedUser, validateId } from '../../../../utils/order-validation';

const CARTS_TABLE = process.env.CARTS_TABLE_NAME;
const SHELF_ITEMS_TABLE = process.env.SHELF_ITEMS_TABLE_NAME;

interface ValidateCartResponse {
  cartId: string;
  isValid: boolean;
  availableItems: Array<{ shelfItemId: string; currentQty: number; price: number }>;
  unavailableItems: Array<{ shelfItemId: string; reason: string }>;
  totalItemsInCart: number;
}

/**
 * Validate Cart Lambda
 * 
 * Checks if all cart items are still available before checkout
 * Returns detailed availability status for each item
 */
export const handler = async (event: {
  arguments?: { cartId?: string };
  identity?: any;
}): Promise<ValidateCartResponse> => {
  initTelemetryLogger(event, { domain: 'order-domain', service: 'validate-cart' });

  if (!CARTS_TABLE || !SHELF_ITEMS_TABLE) {
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
    // Get cart
    const cartResult = await client.send(
      new GetCommand({
        TableName: CARTS_TABLE,
        Key: { cartId: safeCartId },
      })
    );

    if (!cartResult.Item) {
      return {
        cartId: safeCartId,
        isValid: false,
        availableItems: [],
        unavailableItems: [],
        totalItemsInCart: 0,
      };
    }

    const cart = cartResult.Item as any;
    if (cart.collectorUserId !== auth) {
      throw new Error('Forbidden');
    }
    const cartItems = Array.isArray(cart.items) ? cart.items : [];

    if (cartItems.length === 0) {
      return {
        cartId: safeCartId,
        isValid: false,
        availableItems: [],
        unavailableItems: [],
        totalItemsInCart: 0,
      };
    }

    // Batch get all shelf items
    const shelfItemResults = await client.send(
      new BatchGetCommand({
        RequestItems: {
          [SHELF_ITEMS_TABLE]: {
            Keys: cartItems.map((item: any) => ({ shelfItemId: item.shelfItemId })),
          },
        },
      })
    );

    const shelfItemsMap = new Map();
    const items = shelfItemResults.Responses?.[SHELF_ITEMS_TABLE] || [];
    items.forEach((item: any) => {
      shelfItemsMap.set(item.shelfItemId, item);
    });

    // Validate each cart item
    const availableItems: Array<{ shelfItemId: string; currentQty: number; price: number }> = [];
    const unavailableItems: Array<{ shelfItemId: string; reason: string }> = [];

    for (const cartItem of cartItems) {
      const shelfItem = shelfItemsMap.get(cartItem.shelfItemId);

      if (!shelfItem) {
        unavailableItems.push({
          shelfItemId: cartItem.shelfItemId,
          reason: 'Item not found',
        });
      } else if (shelfItem.isSoldOut === true) {
        unavailableItems.push({
          shelfItemId: cartItem.shelfItemId,
          reason: 'Item sold out',
        });
      } else if ((shelfItem.quantityAvailable ?? 0) < cartItem.quantity) {
        unavailableItems.push({
          shelfItemId: cartItem.shelfItemId,
          reason: `Insufficient stock (requested: ${cartItem.quantity}, available: ${shelfItem.quantityAvailable})`,
        });
      } else if (shelfItem.shelfStatus !== 'ACTIVE') {
        unavailableItems.push({
          shelfItemId: cartItem.shelfItemId,
          reason: 'Item no longer available',
        });
      } else {
        availableItems.push({
          shelfItemId: cartItem.shelfItemId,
          currentQty: shelfItem.quantityAvailable,
          price: shelfItem.basePrice,
        });
      }
    }

    const isValid = unavailableItems.length === 0;

    console.log('Cart validation complete:', {
      cartId,
      isValid,
      availableCount: availableItems.length,
      unavailableCount: unavailableItems.length,
    });

    return {
      cartId: safeCartId,
      isValid,
      availableItems,
      unavailableItems,
      totalItemsInCart: cartItems.length,
    };
  } catch (err) {
    console.error('Validate cart failed:', err);
    throw err;
  }
};
