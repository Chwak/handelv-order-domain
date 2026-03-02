import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import * as path from 'path';

export interface GetOrderLambdaConstructProps {
  environment: string;
  regionCode: string;
  ordersTable: dynamodb.ITable;
  orderItemsTable: dynamodb.ITable;
  removalPolicy?: cdk.RemovalPolicy;
}

export class GetOrderLambdaConstruct extends Construct {
  public readonly function: lambda.Function;

  constructor(scope: Construct, id: string, props: GetOrderLambdaConstructProps) {
    super(scope, id);

    const role = new iam.Role(this, 'GetOrderLambdaRole', {
      roleName: `${props.environment}-${props.regionCode}-order-domain-get-order-lambda-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'IAM role for Get Order Lambda',
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
                `arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/lambda/${props.environment}-${props.regionCode}-order-domain-get-order-lambda*`,
              ],
            }),
          ],
        }),
        DynamoDBAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['dynamodb:GetItem', 'dynamodb:Query'],
              resources: [
                props.ordersTable.tableArn,
                props.orderItemsTable.tableArn,
              ],
            }),
          ],
        }),
      },
    });

    const logGroup = new logs.LogGroup(this, 'GetOrderLogGroup', {
      logGroupName: `/aws/lambda/${props.environment}-${props.regionCode}-order-domain-get-order-lambda`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: props.removalPolicy ?? cdk.RemovalPolicy.DESTROY,
    });

    const lambdaCodePath = path.join(__dirname, '../../../../functions/lambda/order/get-order');
    this.function = new lambda.Function(this, 'GetOrderFunction', {
      functionName: `${props.environment}-${props.regionCode}-order-domain-get-order-lambda`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'get-order-lambda.handler',
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
        LOG_LEVEL: props.environment === 'prod' ? 'ERROR' : 'INFO',
      },
      description: 'Get order by order ID',
    });

    props.ordersTable.grantReadData(this.function);
    props.orderItemsTable.grantReadData(this.function);


    if (props.removalPolicy) {
      this.function.applyRemovalPolicy(props.removalPolicy);
    }
  }
}
