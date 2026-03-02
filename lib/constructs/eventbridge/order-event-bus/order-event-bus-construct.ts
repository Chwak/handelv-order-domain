import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface OrderEventBusConstructProps {
  environment: string;
  regionCode: string;
  removalPolicy?: cdk.RemovalPolicy;
}

/**
 * EventBridge Bus Construct for Order Domain
 * 
 * This is the SINGLE EventBridge bus for the entire platform.
 * All domains import this bus via SSM to publish and consume events.
 * 
 * IMPORTANT: Only Order Domain creates this bus. Other domains MUST import it.
 */
export class OrderEventBusConstruct extends Construct {
  public readonly eventBus: events.EventBus;
  public readonly eventBusName: string;
  public readonly eventBusArn: string;

  constructor(scope: Construct, id: string, props: OrderEventBusConstructProps) {
    super(scope, id);

    const removalPolicy = props.removalPolicy || cdk.RemovalPolicy.DESTROY;

    // Create EventBridge custom event bus
    this.eventBus = new events.EventBus(this, 'OrderEventBus', {
      eventBusName: `${props.environment}-${props.regionCode}-hand-made-events`,
      description: 'Shared EventBridge bus for all hand-made platform domains',
    });

    // Apply removal policy
    if (removalPolicy === cdk.RemovalPolicy.DESTROY) {
      this.eventBus.applyRemovalPolicy(removalPolicy);
    }

    this.eventBusName = this.eventBus.eventBusName;
    this.eventBusArn = this.eventBus.eventBusArn;

    // Export EventBridge bus name to SSM for cross-stack references
    new ssm.StringParameter(this, 'EventBusNameParameter', {
      parameterName: `/${props.environment}/order-domain/eventbridge/event-bus-name`,
      stringValue: this.eventBusName,
      description: 'Order Domain EventBridge Bus Name (shared across all domains)',
    });

    // Export EventBridge bus ARN to SSM for IAM permissions
    new ssm.StringParameter(this, 'EventBusArnParameter', {
      parameterName: `/${props.environment}/order-domain/eventbridge/event-bus-arn`,
      stringValue: this.eventBusArn,
      description: 'Order Domain EventBridge Bus ARN (shared across all domains)',
    });

    // CloudFormation outputs
    new cdk.CfnOutput(this, 'EventBusName', {
      value: this.eventBusName,
      description: 'EventBridge Bus Name',
      exportName: `${props.environment}-${props.regionCode}-order-domain-event-bus-name`,
    });

    new cdk.CfnOutput(this, 'EventBusArn', {
      value: this.eventBusArn,
      description: 'EventBridge Bus ARN',
      exportName: `${props.environment}-${props.regionCode}-order-domain-event-bus-arn`,
    });
  }
}
