import * as cdk from 'aws-cdk-lib';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as path from 'path';
import * as fs from 'fs';
import { Construct } from 'constructs';

export interface OrderStateMachineConstructProps {
  environment: string;
  regionCode: string;
  ordersTable: dynamodb.ITable;
  orderItemsTable: dynamodb.ITable;
  eventBus?: events.IEventBus;
}

export class OrderStateMachineConstruct extends Construct {
  public readonly stateMachine: stepfunctions.StateMachine;
  public readonly stateMachineArn: string;

  constructor(scope: Construct, id: string, props: OrderStateMachineConstructProps) {
    super(scope, id);

    // Create CloudWatch Log Group for Step Functions
    const logGroup = new logs.LogGroup(this, 'OrderStateMachineLogGroup', {
      logGroupName: `/aws/stepfunctions/${props.environment}-${props.regionCode}-order-domain-state-machine`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Read ASL JSON definition and perform substitutions
    const aslFilePath = path.join(__dirname, 'order-state-machine.asl.json');
    let aslContent = fs.readFileSync(aslFilePath, 'utf-8');
    aslContent = aslContent.replace(/\${OrdersTableName}/g, props.ordersTable.tableName);
    aslContent = aslContent.replace(/\${OrderItemsTableName}/g, props.orderItemsTable.tableName);
    
    const definitionBody = stepfunctions.DefinitionBody.fromString(aslContent);

    // Create Express Step Functions state machine (synchronous execution)
    this.stateMachine = new stepfunctions.StateMachine(this, 'OrderStateMachine', {
      stateMachineName: `${props.environment}-${props.regionCode}-order-domain-state-machine`,
      definitionBody: definitionBody,
      stateMachineType: stepfunctions.StateMachineType.EXPRESS,
      timeout: cdk.Duration.minutes(5),
      tracingEnabled: false,
      logs: {
        destination: logGroup,
        level: stepfunctions.LogLevel.ALL,
        includeExecutionData: true,
      },
    });

    this.stateMachineArn = this.stateMachine.stateMachineArn;

    // Grant permissions for native DynamoDB integrations
    props.ordersTable.grantReadWriteData(this.stateMachine);
    props.orderItemsTable.grantReadWriteData(this.stateMachine);

    // Grant EventBridge PutEvents permission if eventBus is provided
    if (props.eventBus) {
      props.eventBus.grantPutEventsTo(this.stateMachine);
    }

    // Export to SSM
    new ssm.StringParameter(this, 'OrderStateMachineArnParameter', {
      parameterName: `/${props.environment}/order-domain/stepfunctions/state-machine-arn`,
      stringValue: this.stateMachineArn,
      description: 'Order Domain Step Functions State Machine ARN',
    });

    new cdk.CfnOutput(this, 'OrderStateMachineArn', {
      value: this.stateMachineArn,
      description: 'Order Domain Step Functions State Machine ARN',
      exportName: `${props.environment}-${props.regionCode}-order-domain-state-machine-arn`,
    });
  }
}
