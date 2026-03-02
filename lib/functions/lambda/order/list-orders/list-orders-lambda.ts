import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, type QueryCommandInput } from '@aws-sdk/lib-dynamodb';
import { initTelemetryLogger } from "../../../../utils/telemetry-logger";
import {
  encodeNextToken,
  parseNextToken,
  requireAuthenticatedUser,
  validateId,
  validateLimit,
  validateOrderStatus,
} from '../../../../utils/order-validation';

const ORDERS_TABLE = process.env.ORDERS_TABLE_NAME;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

const GSI1_COLLECTOR = 'GSI1-CollectorUserId';
const GSI2_MAKER = 'GSI2-MakerUserId';
const GSI3_PRODUCT = 'GSI3-ProductId';
const GSI4_STATUS = 'GSI4-Status';

export const handler = async (event: {
  arguments?: {
    collectorUserId?: unknown;
    makerUserId?: unknown;
    productId?: unknown;
    status?: unknown;
    limit?: unknown;
    nextToken?: unknown;
  };
  identity?: { sub?: string; claims?: { sub?: string } };
}) => {
  initTelemetryLogger(event, { domain: "order-domain", service: "list-orders" });
  if (!ORDERS_TABLE) throw new Error('Internal server error');

  const auth = requireAuthenticatedUser(event);
  if (!auth) throw new Error('Not authenticated');

  const args = event.arguments ?? {};
  const collectorUserId = args.collectorUserId != null ? validateId(args.collectorUserId) : null;
  const makerUserId = args.makerUserId != null ? validateId(args.makerUserId) : null;
  const productId = args.productId != null ? validateId(args.productId) : null;
  const status = args.status != null ? validateOrderStatus(args.status) : null;

  if (!collectorUserId && !makerUserId) {
    throw new Error('collectorUserId or makerUserId is required');
  }
  if (collectorUserId && collectorUserId !== auth) throw new Error('Forbidden');
  if (makerUserId && makerUserId !== auth) throw new Error('Forbidden');

  const limit = validateLimit(args.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const nextToken = parseNextToken(args.nextToken);

  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  let indexName: string;
  let keyCondition: string;
  let expressionAttributeValues: Record<string, unknown>;

  if (collectorUserId) {
    indexName = GSI1_COLLECTOR;
    keyCondition = 'collectorUserId = :uid';
    expressionAttributeValues = { ':uid': collectorUserId };
  } else if (makerUserId) {
    indexName = GSI2_MAKER;
    keyCondition = 'makerUserId = :uid';
    expressionAttributeValues = { ':uid': makerUserId };
  } else {
    throw new Error('collectorUserId or makerUserId is required');
  }

  const queryInput: Record<string, unknown> = {
    TableName: ORDERS_TABLE,
    IndexName: indexName,
    KeyConditionExpression: keyCondition,
    ExpressionAttributeValues: expressionAttributeValues,
    Limit: limit,
  };
  if (productId || status) {
    const filterParts: string[] = [];
    const names: Record<string, string> = {};
    if (productId) {
      filterParts.push('productId = :lid');
      (queryInput.ExpressionAttributeValues as Record<string, unknown>)[':lid'] = productId;
    }
    if (status) {
      filterParts.push('#st = :st');
      names['#st'] = 'status';
      (queryInput.ExpressionAttributeValues as Record<string, unknown>)[':st'] = status;
    }
    if (filterParts.length > 0) {
      queryInput.FilterExpression = filterParts.join(' AND ');
      if (Object.keys(names).length > 0) {
        queryInput.ExpressionAttributeNames = names;
      }
    }
  }
  if (nextToken && typeof nextToken === 'object' && Object.keys(nextToken).length > 0) {
    queryInput.ExclusiveStartKey = nextToken as Record<string, unknown>;
  }

  const result = await client.send(new QueryCommand(queryInput as QueryCommandInput));
  const items = (result.Items ?? []) as Record<string, unknown>[];
  const newNextToken = result.LastEvaluatedKey
    ? encodeNextToken(result.LastEvaluatedKey as Record<string, unknown>)
    : null;

  return {
    items,
    nextToken: newNextToken,
  };
}