import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import { requireAuthenticatedUser, validateId, validateOrderStatus } from '../../../../utils/order-validation';
import { initTelemetryLogger } from "../../../../utils/telemetry-logger";

function resolveTraceparent(event: { headers?: Record<string, string> }): string {
  const headerTraceparent = event.headers?.traceparent || event.headers?.Traceparent;
  const isValid = headerTraceparent && /^\d{2}-[0-9a-f]{32}-[0-9a-f]{16}-\d{2}$/i.test(headerTraceparent);
  if (isValid) return headerTraceparent;
  const traceId = randomUUID().replace(/-/g, '');
  const spanId = randomUUID().replace(/-/g, '').slice(0, 16);
  return `00-${traceId}-${spanId}-01`;
}

const ORDERS_TABLE = process.env.ORDERS_TABLE_NAME;

const VALID_TRANSITIONS: Record<string, Set<string>> = {
  PENDING: new Set(['PAID', 'CANCELED']),
  PAID: new Set(['IN_PROGRESS', 'CANCELED']),
  IN_PROGRESS: new Set(['SHIPPED', 'CANCELED']),
  SHIPPED: new Set(['DELIVERED', 'CANCELED']),
  DELIVERED: new Set(['COMPLETED']),
  COMPLETED: new Set(),
  CANCELED: new Set(),
};

export const handler = async (event: {
  arguments?: { input?: { orderId?: unknown; status?: unknown } };
  identity?: { sub?: string; claims?: { sub?: string } };
  headers?: Record<string, string>;
}) => {
  initTelemetryLogger(event, { domain: "order-domain", service: "update-order-status" });
  const traceparent = resolveTraceparent(event);
  if (!ORDERS_TABLE) throw new Error('Internal server error');

  const input = event.arguments?.input ?? {};
  const orderId = validateId(input.orderId);
  const newStatus = validateOrderStatus(input.status);
  if (!orderId || !newStatus) throw new Error('Invalid input format');

  const auth = requireAuthenticatedUser(event, 'maker');
  if (!auth) throw new Error('Not authenticated');

  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  const getResult = await client.send(
    new GetCommand({
      TableName: ORDERS_TABLE,
      Key: { orderId },
    })
  );
  const order = getResult.Item as Record<string, unknown> | undefined;
  if (!order) throw new Error('Order not found');

  const collectorUserId = order.collectorUserId as string;
  const makerUserId = order.makerUserId as string;
  if (auth !== collectorUserId && auth !== makerUserId) throw new Error('Forbidden');

  const currentStatus = (order.status as string) ?? 'PENDING';
  const allowed = VALID_TRANSITIONS[currentStatus];
  if (!allowed?.has(newStatus)) throw new Error('Invalid status transition');

  const now = new Date().toISOString();
  const updateExpr: string[] = ['#st = :status', 'updatedAt = :now'];
  const attrValues: Record<string, unknown> = { ':status': newStatus, ':now': now };

  if (newStatus === 'SHIPPED') {
    updateExpr.push('shippedAt = :now');
  }
  if (newStatus === 'DELIVERED' || newStatus === 'COMPLETED') {
    updateExpr.push('deliveredAt = :now');
  }
  if (newStatus === 'CANCELED') {
    updateExpr.push('canceledAt = :now');
  }

  const updateResult = await client.send(
    new UpdateCommand({
      TableName: ORDERS_TABLE,
      Key: { orderId },
      UpdateExpression: `SET ${updateExpr.join(', ')}`,
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: attrValues,
      ReturnValues: 'ALL_NEW',
    })
  );

  return updateResult.Attributes ?? order;
};