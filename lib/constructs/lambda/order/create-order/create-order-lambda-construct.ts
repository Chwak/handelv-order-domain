import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import * as path from 'path';

export interface CreateOrderLambdaConstructProps {
  environment: string;
  regionCode: string;
  ordersTable: dynamodb.ITable;
  orderItemsTable: dynamodb.ITable;
  stockHoldsTable: dynamodb.ITable;
  outboxTable: dynamodb.ITable;
  eventBusArn: string;
  eventBusName: string;
  removalPolicy?: cdk.RemovalPolicy;
}

export class CreateOrderLambdaConstruct extends Construct {
  public readonly function: lambda.Function;

  constructor(scope: Construct, id: string, props: CreateOrderLambdaConstructProps) {
    super(scope, id);

    const role = new iam.Role(this, 'CreateOrderLambdaRole', {
      roleName: `${props.environment}-${props.regionCode}-order-domain-create-order-lambda-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'IAM role for Create Order Lambda',
      inlinePolicies: {
        CloudWatchLogsAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'logs:CreateLogGroup',
                'logs:CreateLogStream',
                'logs:PutLogEvents',
              ],
              resources: [
                `arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/lambda/${props.environment}-${props.regionCode}-order-domain-create-order-lambda*`,
              ],
            }),
          ],
        }),
        DynamoDBAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['dynamodb:PutItem', 'dynamodb:GetItem', 'dynamodb:BatchWriteItem', 'dynamodb:UpdateItem', 'dynamodb:Query'],
              resources: [
                props.ordersTable.tableArn,
                props.orderItemsTable.tableArn,
                props.stockHoldsTable.tableArn,
                props.outboxTable.tableArn,
                `${props.stockHoldsTable.tableArn}/index/*`,
              ],
            }),
            // Read-only access to Discovery shelf items table (cross-domain)
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['dynamodb:GetItem', 'dynamodb:Query'],
              resources: [
                `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/${props.environment}-*-shelf-discovery-domain-shelf-items-table`,
              ],
            }),
          ],
        }),
        EventBridgeAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['events:PutEvents'],
              resources: [props.eventBusArn],
            }),
          ],
        }),
      },
    });

    const logGroup = new logs.LogGroup(this, 'CreateOrderLogGroup', {
      logGroupName: `/aws/lambda/${props.environment}-${props.regionCode}-order-domain-create-order-lambda`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: props.removalPolicy ?? cdk.RemovalPolicy.DESTROY,
    });

    const lambdaCodePath = path.join(__dirname, '../../../../functions/lambda/order/create-order');
    this.function = new lambda.Function(this, 'CreateOrderFunction', {
      functionName: `${props.environment}-${props.regionCode}-order-domain-create-order-lambda`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'create-order-lambda.handler',
      code: lambda.Code.fromAsset(lambdaCodePath),
      role,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      tracing: lambda.Tracing.DISABLED,
      logGroup,
      environment: {
        ENVIRONMENT: props.environment,
        REGION_CODE: props.regionCode,
        ORDERS_TABLE_NAME: props.ordersTable.tableName,
        ORDER_ITEMS_TABLE_NAME: props.orderItemsTable.tableName,
        STOCK_HOLDS_TABLE_NAME: props.stockHoldsTable.tableName,
        SHELF_ITEMS_TABLE_NAME: `${props.environment}-${props.regionCode}-shelf-discovery-domain-shelf-items-table`,
        EVENT_BUS_NAME: props.eventBusName,
        OUTBOX_TABLE_NAME: props.outboxTable.tableName,
        LOG_LEVEL: props.environment === 'prod' ? 'ERROR' : 'INFO',
      },
      description: 'Create order and order items in DynamoDB with stock hold',
    });

    props.ordersTable.grantReadWriteData(this.function);
    props.orderItemsTable.grantReadWriteData(this.function);
    props.stockHoldsTable.grantReadWriteData(this.function);
    props.outboxTable.grantReadWriteData(this.function);

    if (props.removalPolicy) {
      this.function.applyRemovalPolicy(props.removalPolicy);
    }
  }
}
