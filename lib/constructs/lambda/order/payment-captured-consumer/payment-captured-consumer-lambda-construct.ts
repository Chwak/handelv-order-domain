import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import * as path from 'path';

export interface PaymentCapturedConsumerLambdaConstructProps {
  environment: string;
  regionCode: string;
  ordersTable: dynamodb.ITable;
  outboxTable: dynamodb.ITable;
  eventBusArn: string;
  removalPolicy?: cdk.RemovalPolicy;
}

export class PaymentCapturedConsumerLambdaConstruct extends Construct {
  public readonly function: NodejsFunction;

  constructor(scope: Construct, id: string, props: PaymentCapturedConsumerLambdaConstructProps) {
    super(scope, id);

    const role = new iam.Role(this, 'PaymentCapturedConsumerLambdaRole', {
      roleName: `${props.environment}-${props.regionCode}-order-domain-payment-captured-consumer-role`,
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
          `arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/lambda/${props.environment}-${props.regionCode}-order-domain-payment-captured-consumer*`,
        ],
      })
    );

    // DynamoDB permissions
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          'dynamodb:GetItem',
          'dynamodb:UpdateItem',
        ],
        resources: [
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
    const logGroup = new logs.LogGroup(this, 'PaymentCapturedConsumerLogGroup', {
      logGroupName: `/aws/lambda/${props.environment}-${props.regionCode}-order-domain-payment-captured-consumer`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: props.removalPolicy ?? cdk.RemovalPolicy.DESTROY,
    });

    const lambdaCodePath = path.join(__dirname, '../../../../functions/lambda/order/payment-captured-consumer/payment-captured-consumer-lambda.ts');
    this.function = new NodejsFunction(this, 'PaymentCapturedConsumerFunction', {
      functionName: `${props.environment}-${props.regionCode}-order-domain-payment-captured-consumer`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'handler',
      entry: lambdaCodePath,
      role,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      logGroup,
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'node22',
        externalModules: ['@aws-sdk/*'],
      },
      environment: {
        ORDERS_TABLE_NAME: props.ordersTable.tableName,
        EVENT_BUS_NAME: process.env.EVENT_BUS_NAME || '',
        OUTBOX_TABLE_NAME: props.outboxTable.tableName,
      },
    });
  }
}
