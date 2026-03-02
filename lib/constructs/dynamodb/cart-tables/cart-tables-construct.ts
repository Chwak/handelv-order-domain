import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface CartTablesConstructProps {
  environment: string;
  regionCode: string;
}

/**
 * Cart Tables Construct
 * 
 * Manages transient shopping cart data with automatic cleanup
 * - cartTable: Session-based carts (cartId = session-{userId})
 * - cartItemIdempotencyTable: Prevents duplicate items in cart
 */
export class CartTablesConstruct extends Construct {
  public readonly cartTable: dynamodb.Table;
  public readonly cartIdempotencyTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: CartTablesConstructProps) {
    super(scope, id);

    const removalPolicy = props.environment === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;

    // ==================== CART TABLE ====================
    // Transient shopping carts with 1-hour TTL
    // Schema: cartId (PK), items (list), subtotal, lastModified, expiresAt (TTL)
    this.cartTable = new dynamodb.Table(this, 'CartsTable', {
      tableName: `${props.environment}-${props.regionCode}-order-domain-carts-table`,
      partitionKey: {
        name: 'cartId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: removalPolicy,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: props.environment === 'prod' },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: 'expiresAt', // Auto-cleanup after 1 hour
    });

    // GSI: carts by collectorUserId (find user's current cart)
    this.cartTable.addGlobalSecondaryIndex({
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

    // ==================== CART ITEM IDEMPOTENCY TABLE ====================
    // Prevents duplicate items from being added to cart multiple times
    // Key: {cartId, shelfItemId}, ensures one entry per item per cart
    this.cartIdempotencyTable = new dynamodb.Table(
      this,
      'CartItemIdempotencyTable',
      {
        tableName: `${props.environment}-${props.regionCode}-order-domain-cart-item-idempotency-table`,
        partitionKey: {
          name: 'cartItemId',
          type: dynamodb.AttributeType.STRING,
        },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: removalPolicy,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: props.environment === 'prod' },
        encryption: dynamodb.TableEncryption.AWS_MANAGED,
        timeToLiveAttribute: 'expiresAt', // Cleanup when cart expires
      }
    );

    // GSI: items by cartId (find all items in cart for validation)
    this.cartIdempotencyTable.addGlobalSecondaryIndex({
      indexName: 'GSI1-CartId',
      partitionKey: {
        name: 'cartId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'shelfItemId',
        type: dynamodb.AttributeType.STRING,
      },
    });
  }
}
