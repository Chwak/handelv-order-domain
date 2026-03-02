import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import * as path from 'path';

export interface ConfirmStockHoldsLambdaConstructProps {
  environment: string;
  regionCode: string;
  stockHoldsTable: dynamodb.ITable;
  ordersTable: dynamodb.ITable;
  outboxTable: dynamodb.ITable;
  eventBusArn: string;
  removalPolicy?: cdk.RemovalPolicy;
}

export class ConfirmStockHoldsLambdaConstruct extends Construct {
  public readonly function: lambda.Function;

  constructor(scope: Construct, id: string, props: ConfirmStockHoldsLambdaConstructProps) {
    super(scope, id);

    const role = new iam.Role(this, 'ConfirmStockHoldsLambdaRole', {
      roleName: `${props.environment}-${props.regionCode}-order-domain-confirm-stock-holds-role`,
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
          `arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/lambda/${props.environment}-${props.regionCode}-order-domain-confirm-stock-holds*`,
        ],
      })
    );

    // DynamoDB permissions
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          'dynamodb:GetItem',
          'dynamodb:UpdateItem',
          'dynamodb:Query',
        ],
        resources: [
          props.stockHoldsTable.tableArn,
          `${props.stockHoldsTable.tableArn}/index/*`,
          props.ordersTable.tableArn,
          props.outboxTable.tableArn,
        ],
      })
    );

    // EventBridge publish permission
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['events:PutEvents'],
        resources: [props.eventBusArn],
      })
    );

    // Log group
    const logGroup = new logs.LogGroup(this, 'ConfirmStockHoldsLogGroup', {
      logGroupName: `/aws/lambda/${props.environment}-${props.regionCode}-order-domain-confirm-stock-holds`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: props.removalPolicy ?? cdk.RemovalPolicy.DESTROY,
    });

    const lambdaCodePath = path.join(__dirname, '../../../../functions/lambda/cart/confirm-stock-holds');
    this.function = new lambda.Function(this, 'ConfirmStockHoldsFunction', {
      functionName: `${props.environment}-${props.regionCode}-order-domain-confirm-stock-holds`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'confirm-stock-holds-lambda.handler',
      code: lambda.Code.fromAsset(lambdaCodePath),
      role,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      logGroup,
      environment: {
        STOCK_HOLDS_TABLE_NAME: props.stockHoldsTable.tableName,
        ORDERS_TABLE_NAME: props.ordersTable.tableName,
        EVENT_BUS_NAME: process.env.EVENT_BUS_NAME || '',
        OUTBOX_TABLE_NAME: props.outboxTable.tableName,
      },
    });
  }
}
