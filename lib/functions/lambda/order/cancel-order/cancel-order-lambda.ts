import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import { requireAuthenticatedUser, validateId } from '../../../../utils/order-validation';
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

const NON_CANCELABLE_STATUSES = new Set(['COMPLETED', 'CANCELED']);

function validateCancelReason(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (t.length > 500) return null;
  return t || null;
}

export const handler = async (event: {
  arguments?: { input?: { orderId?: unknown; cancelReason?: unknown } };
  identity?: { sub?: string; claims?: { sub?: string } };
  headers?: Record<string, string>;
}) => {
  initTelemetryLogger(event, { domain: "order-domain", service: "cancel-order" });
  const traceparent = resolveTraceparent(event);
  if (!ORDERS_TABLE) throw new Error('Internal server error');

  const input = event.arguments?.input ?? {};
  const orderId = validateId(input.orderId);
  if (!orderId) throw new Error('Invalid input format');

  const auth = requireAuthenticatedUser(event);
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

  const status = (order.status as string) ?? '';
  if (NON_CANCELABLE_STATUSES.has(status)) throw new Error('Order cannot be canceled');

  const now = new Date().toISOString();
  const cancelReason = validateCancelReason(input.cancelReason) ?? '';

  const updateResult = await client.send(
    new UpdateCommand({
      TableName: ORDERS_TABLE,
      Key: { orderId },
      UpdateExpression: 'SET #st = :status, canceledAt = :now, cancelReason = :reason, updatedAt = :now',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: {
        ':status': 'CANCELED',
        ':now': now,
        ':reason': cancelReason,
      },
      ReturnValues: 'ALL_NEW',
    })
  );

  return updateResult.Attributes ?? order;
};