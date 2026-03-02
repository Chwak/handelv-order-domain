import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'path';

export interface CartOperationsLambdaConstructProps {
  environment: string;
  regionCode: string;
  cartTable: dynamodb.ITable;
  cartIdempotencyTable: dynamodb.ITable;
  shelfItemsTable?: dynamodb.ITable; // Optional - can be updated after stack created
  stockHoldsTable: dynamodb.ITable;
  ordersTable: dynamodb.ITable;
  outboxTable: dynamodb.ITable;
}

/**
 * Cart Operations Lambda Construct
 * 
 * Manages shopping cart lifecycle:
 * - addToCart: Add/update item in cart
 * - getCart: Retrieve cart contents
 * - removeFromCart: Remove item from cart
 * - validateCart: Check item availability before checkout
 * - checkout: Convert cart to order with stock holds
 */
export class CartOperationsLambdaConstruct extends Construct {
  public readonly addToCartFunction: lambda.Function;
  public readonly getCartFunction: lambda.Function;
  public readonly removeFromCartFunction: lambda.Function;
  public readonly validateCartFunction: lambda.Function;
  public readonly checkoutFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: CartOperationsLambdaConstructProps) {
    super(scope, id);

    const role = new iam.Role(this, 'CartOperationsLambdaRole', {
      roleName: `${props.environment}-${props.regionCode}-order-domain-cart-operations-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });

    // CloudWatch Logs permissions
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
        ],
        resources: [
          `arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/lambda/${props.environment}-${props.regionCode}-order-domain-cart-*`,
          `arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/lambda/${props.environment}-${props.regionCode}-order-domain-checkout-lambda*`,
        ],
      })
    );

    // DynamoDB permissions for all tables
    const resources: string[] = [
      props.cartTable.tableArn,
      `${props.cartTable.tableArn}/index/*`,
      props.cartIdempotencyTable.tableArn,
      `${props.cartIdempotencyTable.tableArn}/index/*`,
      props.stockHoldsTable.tableArn,
      `${props.stockHoldsTable.tableArn}/index/*`,
      props.ordersTable.tableArn,
      `${props.ordersTable.tableArn}/index/*`,
      props.outboxTable.tableArn,
    ];

    // Add shelf items table if provided
    if (props.shelfItemsTable) {
      resources.push(props.shelfItemsTable.tableArn);
      resources.push(`${props.shelfItemsTable.tableArn}/index/*`);
    }

    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
          'dynamodb:DeleteItem',
          'dynamodb:Query',
          'dynamodb:Scan',
          'dynamodb:BatchGetItem',
        ],
        resources,
      })
    );

    const commonEnv: Record<string, string> = {
      CARTS_TABLE_NAME: props.cartTable.tableName,
      CART_ITEM_IDEMPOTENCY_TABLE_NAME: props.cartIdempotencyTable.tableName,
      STOCK_HOLDS_TABLE_NAME: props.stockHoldsTable.tableName,
      ORDERS_TABLE_NAME: props.ordersTable.tableName,
      OUTBOX_TABLE_NAME: props.outboxTable.tableName,
      ENVIRONMENT: props.environment,
      CART_TTL_SECONDS: '3600', // 1 hour
      STOCK_HOLD_TTL_SECONDS: '1800', // 30 minutes
      // EventBridge will be set from SSM parameter in stack
      EVENT_BUS_NAME: process.env.EVENT_BUS_NAME || '',
    };

    // Add shelf items table if provided (from Discovery domain)
    if (props.shelfItemsTable) {
      commonEnv.SHELF_ITEMS_TABLE_NAME = props.shelfItemsTable.tableName;
    }

    // Create manual log groups (not automated)
    const addToCartLogGroup = new logs.LogGroup(this, 'AddToCartLogGroup', {
      logGroupName: `/aws/lambda/${props.environment}-${props.regionCode}-order-domain-add-to-cart`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const getCartLogGroup = new logs.LogGroup(this, 'GetCartLogGroup', {
      logGroupName: `/aws/lambda/${props.environment}-${props.regionCode}-order-domain-get-cart`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const removeFromCartLogGroup = new logs.LogGroup(this, 'RemoveFromCartLogGroup', {
      logGroupName: `/aws/lambda/${props.environment}-${props.regionCode}-order-domain-remove-from-cart`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const validateCartLogGroup = new logs.LogGroup(this, 'ValidateCartLogGroup', {
      logGroupName: `/aws/lambda/${props.environment}-${props.regionCode}-order-domain-validate-cart`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const checkoutLogGroup = new logs.LogGroup(this, 'CheckoutLogGroup', {
      logGroupName: `/aws/lambda/${props.environment}-${props.regionCode}-order-domain-checkout`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Add to Cart Lambda
    this.addToCartFunction = new lambda.Function(this, 'AddToCartLambda', {
      functionName: `${props.environment}-${props.regionCode}-order-domain-add-to-cart`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'add-to-cart-lambda.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../../../functions/lambda/cart/add-to-cart')),
      role,
      environment: commonEnv,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      description: 'Add or update item in shopping cart',
      logGroup: addToCartLogGroup,
    });

    // Get Cart Lambda
    this.getCartFunction = new lambda.Function(this, 'GetCartLambda', {
      functionName: `${props.environment}-${props.regionCode}-order-domain-get-cart`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'get-cart-lambda.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../../../functions/lambda/cart/get-cart')),
      role,
      environment: commonEnv,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      description: 'Retrieve shopping cart contents',
      logGroup: getCartLogGroup,
    });

    // Remove from Cart Lambda
    this.removeFromCartFunction = new lambda.Function(this, 'RemoveFromCartLambda', {
      functionName: `${props.environment}-${props.regionCode}-order-domain-remove-from-cart`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'remove-from-cart-lambda.handler',
      code: lambda.Code.fromAsset(
        path.join(__dirname, '../../../../functions/lambda/cart/remove-from-cart')
      ),
      role,
      environment: commonEnv,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      description: 'Remove item from shopping cart',
      logGroup: removeFromCartLogGroup,
    });

    // Validate Cart Lambda
    this.validateCartFunction = new lambda.Function(this, 'ValidateCartLambda', {
      functionName: `${props.environment}-${props.regionCode}-order-domain-validate-cart`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'validate-cart-lambda.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../../../functions/lambda/cart/validate-cart')),
      role,
      environment: commonEnv,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      description: 'Validate cart items are available before checkout',
      logGroup: validateCartLogGroup,
    });

    // Checkout Lambda (converts cart to order)
    this.checkoutFunction = new lambda.Function(this, 'CheckoutLambda', {
      functionName: `${props.environment}-${props.regionCode}-order-domain-checkout`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'checkout-lambda.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../../../functions/lambda/cart/checkout')),
      role,
      environment: commonEnv,
      timeout: cdk.Duration.seconds(60),
      memorySize: 1024,
      description: 'Convert shopping cart to order with stock holds',
      logGroup: checkoutLogGroup,
    });
  }
}
