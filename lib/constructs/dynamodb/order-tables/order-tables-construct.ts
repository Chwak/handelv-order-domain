import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface OrderTablesConstructProps {
  environment: string;
  regionCode: string;
  removalPolicy?: cdk.RemovalPolicy;
}

export class OrderTablesConstruct extends Construct {
  public readonly ordersTable: dynamodb.Table;
  public readonly orderItemsTable: dynamodb.Table;
  public readonly stockHoldsTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: OrderTablesConstructProps) {
    super(scope, id);

    const removalPolicy = props.removalPolicy ?? cdk.RemovalPolicy.DESTROY;

    // Orders Table
    this.ordersTable = new dynamodb.Table(this, 'OrdersTable', {
      tableName: `${props.environment}-${props.regionCode}-order-domain-orders-table`,
      partitionKey: {
        name: 'orderId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: removalPolicy,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: props.environment === 'prod' },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });

    // GSI: orders by collector
    this.ordersTable.addGlobalSecondaryIndex({
      indexName: 'GSI1-CollectorUserId',
      partitionKey: {
        name: 'collectorUserId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'createdAt',
        type: dynamodb.AttributeType.STRING,
      },
    });

    // GSI: orders by maker
    this.ordersTable.addGlobalSecondaryIndex({
      indexName: 'GSI2-MakerUserId',
      partitionKey: {
        name: 'makerUserId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'createdAt',
        type: dynamodb.AttributeType.STRING,
      },
    });

    // GSI: orders by product
    this.ordersTable.addGlobalSecondaryIndex({
      indexName: 'GSI3-ProductId',
      partitionKey: {
        name: 'productId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'createdAt',
        type: dynamodb.AttributeType.STRING,
      },
    });

    // GSI: orders by status
    this.ordersTable.addGlobalSecondaryIndex({
      indexName: 'GSI4-Status',
      partitionKey: {
        name: 'status',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'createdAt',
        type: dynamodb.AttributeType.STRING,
      },
    });

    // Order Items Table
    this.orderItemsTable = new dynamodb.Table(this, 'OrderItemsTable', {
      tableName: `${props.environment}-${props.regionCode}-order-domain-order-items-table`,
      partitionKey: {
        name: 'orderId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'itemId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: removalPolicy,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: props.environment === 'prod' },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });

    // GSI: order items by product
    this.orderItemsTable.addGlobalSecondaryIndex({
      indexName: 'GSI1-ProductId',
      partitionKey: {
        name: 'productId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'orderId',
        type: dynamodb.AttributeType.STRING,
      },
    });

    // ==================== STOCK HOLDS TABLE ====================
    // Temporary stock reservations during order creation
    // Items automatically cleaned up by TTL when hold expires
    this.stockHoldsTable = new dynamodb.Table(this, 'StockHoldsTable', {
      tableName: `${props.environment}-${props.regionCode}-order-domain-stock-holds-table`,
      partitionKey: {
        name: 'holdId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: removalPolicy,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: props.environment === 'prod' },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: 'expiresAt', // Auto-cleanup after 30 minutes if not finalized
    });

    // GSI: holds by orderId (find holds for specific order)
    this.stockHoldsTable.addGlobalSecondaryIndex({
      indexName: 'GSI1-OrderId',
      partitionKey: {
        name: 'orderId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'createdAt',
        type: dynamodb.AttributeType.STRING,
      },
    });

    // GSI: holds by product (check total reserved for a product)
    this.stockHoldsTable.addGlobalSecondaryIndex({
      indexName: 'GSI2-ProductId',
      partitionKey: {
        name: 'productId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'createdAt',
        type: dynamodb.AttributeType.STRING,
      },
    });
  }
}
