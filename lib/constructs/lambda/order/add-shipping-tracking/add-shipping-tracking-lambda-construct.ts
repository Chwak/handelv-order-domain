import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import * as path from 'path';

export interface AddShippingTrackingLambdaConstructProps {
  environment: string;
  regionCode: string;
  ordersTable: dynamodb.ITable;
  removalPolicy?: cdk.RemovalPolicy;
}

export class AddShippingTrackingLambdaConstruct extends Construct {
  public readonly function: lambda.Function;

  constructor(scope: Construct, id: string, props: AddShippingTrackingLambdaConstructProps) {
    super(scope, id);

    const role = new iam.Role(this, 'AddShippingTrackingLambdaRole', {
      roleName: `${props.environment}-${props.regionCode}-order-domain-add-shipping-tracking-lambda-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'IAM role for Add Shipping Tracking Lambda',
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
                `arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/lambda/${props.environment}-${props.regionCode}-order-domain-add-shipping-tracking-lambda*`,
              ],
            }),
          ],
        }),
        DynamoDBAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
              resources: [props.ordersTable.tableArn],
            }),
          ],
        }),
      },
    });

    const logGroup = new logs.LogGroup(this, 'AddShippingTrackingLogGroup', {
      logGroupName: `/aws/lambda/${props.environment}-${props.regionCode}-order-domain-add-shipping-tracking-lambda`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: props.removalPolicy ?? cdk.RemovalPolicy.DESTROY,
    });

    const lambdaCodePath = path.join(__dirname, '../../../../functions/lambda/order/add-shipping-tracking');
    this.function = new lambda.Function(this, 'AddShippingTrackingFunction', {
      functionName: `${props.environment}-${props.regionCode}-order-domain-add-shipping-tracking-lambda`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'add-shipping-tracking-lambda.handler',
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
        LOG_LEVEL: props.environment === 'prod' ? 'ERROR' : 'INFO',
      },
      description: 'Add shipping tracking information to order',
    });

    props.ordersTable.grantReadWriteData(this.function);


    if (props.removalPolicy) {
      this.function.applyRemovalPolicy(props.removalPolicy);
    }
  }
}
