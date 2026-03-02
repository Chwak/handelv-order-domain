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

function validateTrackingNumber(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (t.length < 5 || t.length > 100) return null;
  if (!/^[a-zA-Z0-9\s-]+$/.test(t)) return null;
  return t;
}

const ALLOWED_STATUS_FOR_TRACKING = new Set(['IN_PROGRESS', 'SHIPPED']);

export const handler = async (event: {
  arguments?: { input?: { orderId?: unknown; trackingNumber?: unknown } };
  identity?: { sub?: string; claims?: { sub?: string } };
  headers?: Record<string, string>;
}) => {
  initTelemetryLogger(event, { domain: "order-domain", service: "add-shipping-tracking" });
  const traceparent = resolveTraceparent(event);
  if (!ORDERS_TABLE) throw new Error('Internal server error');

  const input = event.arguments?.input ?? {};
  const orderId = validateId(input.orderId);
  const trackingNumber = validateTrackingNumber(input.trackingNumber);
  if (!orderId || !trackingNumber) throw new Error('Invalid input format');

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

  const makerUserId = order.makerUserId as string;
  if (auth !== makerUserId) throw new Error('Forbidden');

  const status = (order.status as string) ?? '';
  if (!ALLOWED_STATUS_FOR_TRACKING.has(status)) {
    throw new Error('Order status does not allow tracking update');
  }

  const now = new Date().toISOString();
  const updateResult = await client.send(
    new UpdateCommand({
      TableName: ORDERS_TABLE,
      Key: { orderId },
      UpdateExpression:
        'SET shippingTrackingNumber = :tracking, shippedAt = if_not_exists(shippedAt, :now), updatedAt = :now',
      ExpressionAttributeValues: { ':tracking': trackingNumber, ':now': now },
      ReturnValues: 'ALL_NEW',
    })
  );

  return updateResult.Attributes ?? order;
};