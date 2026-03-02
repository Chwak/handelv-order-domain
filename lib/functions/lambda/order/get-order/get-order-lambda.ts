import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { requireAuthenticatedUser, validateId } from '../../../../utils/order-validation';
import { initTelemetryLogger } from "../../../../utils/telemetry-logger";

const ORDERS_TABLE = process.env.ORDERS_TABLE_NAME;
const ORDER_ITEMS_TABLE = process.env.ORDER_ITEMS_TABLE_NAME;

export const handler = async (event: {
  arguments?: { orderId?: unknown };
  identity?: { sub?: string; claims?: { sub?: string } };
}) => {
  initTelemetryLogger(event, { domain: "order-domain", service: "get-order" });
  if (!ORDERS_TABLE || !ORDER_ITEMS_TABLE) throw new Error('Internal server error');

  const orderId = validateId(event.arguments?.orderId);
  if (!orderId) throw new Error('Invalid input format');

  const auth = requireAuthenticatedUser(event);
  if (!auth) throw new Error('Not authenticated');

  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  const orderResult = await client.send(
    new GetCommand({
      TableName: ORDERS_TABLE,
      Key: { orderId },
    })
  );
  const order = orderResult.Item as Record<string, unknown> | undefined;
  if (!order) throw new Error('Order not found');

  const collectorUserId = order.collectorUserId as string;
  const makerUserId = order.makerUserId as string;
  if (auth !== collectorUserId && auth !== makerUserId) throw new Error('Forbidden');

  const itemsResult = await client.send(
    new QueryCommand({
      TableName: ORDER_ITEMS_TABLE,
      KeyConditionExpression: 'orderId = :oid',
      ExpressionAttributeValues: { ':oid': orderId },
    })
  );
  const items = (itemsResult.Items ?? []) as Record<string, unknown>[];

  return {
    ...order,
    items,
  };
};