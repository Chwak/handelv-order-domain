import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';

export interface ExpireStockHoldsLambdaConstructProps {
  environment: string;
  regionCode: string;
  stockHoldsTable: dynamodb.ITable;
  outboxTable: dynamodb.ITable;
  removalPolicy?: RemovalPolicy;
}

export class ExpireStockHoldsLambdaConstruct extends Construct {
  public readonly function: lambda.IFunction;

  constructor(scope: Construct, id: string, props: ExpireStockHoldsLambdaConstructProps) {
    super(scope, id);

    // Lambda function to expire stock holds
    this.function = new lambdaNodeJs.NodejsFunction(this, 'ExpireStockHoldsFunction', {
      functionName: `${props.environment}-${props.regionCode}-order-domain-expire-stock-holds`,
      entry: `${__dirname}/../../../../functions/lambda/scheduled/expire-stock-holds-lambda.ts`,
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: Duration.seconds(180), // 3 minutes for processing many holds
      memorySize: 512,
      environment: {
        STOCK_HOLDS_TABLE_NAME: props.stockHoldsTable.tableName,
        OUTBOX_TABLE_NAME: props.outboxTable.tableName,
        ENVIRONMENT: props.environment,
        REGION_CODE: props.regionCode,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: false,
        sourceMap: false,
      },
    });

    // CloudWatch Log Group
    new logs.LogGroup(this, 'ExpireStockHoldsLogGroup', {
      logGroupName: `/aws/lambda/${props.environment}-${props.regionCode}-order-domain-expire-stock-holds`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: props.removalPolicy ?? RemovalPolicy.DESTROY,
    });

    // Grant permissions
    props.stockHoldsTable.grantReadWriteData(this.function);
    props.outboxTable.grantReadWriteData(this.function);

    // Schedule: Run every 5 minutes
    const rule = new events.Rule(this, 'ExpireHoldsScheduleRule', {
      schedule: events.Schedule.rate(Duration.minutes(5)),
      description: 'Expire stock holds that have passed their TTL',
    });

    rule.addTarget(new targets.LambdaFunction(this.function));
  }
}
