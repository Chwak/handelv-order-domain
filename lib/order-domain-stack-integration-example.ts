import * as cdk from "aws-cdk-lib";
import type { Construct } from "constructs";
import type { DomainStackProps } from "./domain-stack-props";
import { OrderAppSyncConstruct } from "./constructs/appsync/order-appsync/order-appsync-construct";
import { OrderStateMachineConstruct } from "./constructs/stepfunctions/order-state-machine/order-state-machine-construct";
import { CreateOrderLambdaConstruct } from "./constructs/lambda/order/create-order/create-order-lambda-construct";
import { UpdateOrderStatusLambdaConstruct } from "./constructs/lambda/order/update-order-status/update-order-status-lambda-construct";
import { OrderAppSyncResolversConstruct } from "./constructs/appsync/order-appsync-resolvers/order-appsync-resolvers-construct";
// TODO: Import DynamoDB table constructs when created
// TODO: Import shared EventBridge bus when created

/**
 * Example integration showing how to wire together:
 * - AppSync GraphQL API
 * - Step Functions State Machine
 * - Lambda functions (invoke Step Functions)
 * - AppSync resolvers (connect Lambda to GraphQL)
 * - DynamoDB tables
 * - EventBridge bus (shared infra)
 * 
 * This is a reference implementation. Actual implementation should
 * create DynamoDB tables and import the shared EventBridge bus, then wire everything.
 */
export class OrderDomainStackIntegrationExample extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DomainStackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add("Domain", "order-domain");
    cdk.Tags.of(this).add("Environment", props.environment);
    cdk.Tags.of(this).add("Project", "hand-made");
    cdk.Tags.of(this).add("Region", props.regionCode);
    cdk.Tags.of(this).add("StackName", this.stackName);

    const removalPolicy = props.environment === 'prod'
      ? cdk.RemovalPolicy.RETAIN
      : cdk.RemovalPolicy.DESTROY;

    // TODO: Step 1 - Create DynamoDB tables
    // const ordersTable = new OrdersTableConstruct(...);
    // const orderItemsTable = new OrderItemsTableConstruct(...);

    // TODO: Step 2 - Import shared EventBridge bus (from Shared Infra)
    // const eventBusName = ssm.StringParameter.fromStringParameterName(...).stringValue;
    // const eventBus = events.EventBus.fromEventBusName(...);

    // Step 3 - Create Step Functions State Machine
    // const orderStateMachine = new OrderStateMachineConstruct(this, "OrderStateMachine", {
    //   environment: props.environment,
    //   regionCode: props.regionCode,
    //   ordersTable: ordersTable.table,
    //   orderItemsTable: orderItemsTable.table,
    //   eventBus: eventBus,
    // });

    // Step 4 - Create Lambda functions that invoke Step Functions
    // const createOrderLambda = new CreateOrderLambdaConstruct(this, "CreateOrderLambda", {
    //   environment: props.environment,
    //   regionCode: props.regionCode,
    //   stateMachine: orderStateMachine.stateMachine,
    //   removalPolicy,
    // });

    // const updateOrderStatusLambda = new UpdateOrderStatusLambdaConstruct(this, "UpdateOrderStatusLambda", {
    //   environment: props.environment,
    //   regionCode: props.regionCode,
    //   stateMachine: orderStateMachine.stateMachine,
    //   removalPolicy,
    // });

    // Step 5 - Create AppSync GraphQL API
    const orderAppSync = new OrderAppSyncConstruct(this, "OrderAppSync", {
      environment: props.environment,
      regionCode: props.regionCode,
    });

    // Step 6 - Connect Lambda functions to AppSync resolvers
    // const orderResolvers = new OrderAppSyncResolversConstruct(this, "OrderResolvers", {
    //   api: orderAppSync.api,
    //   createOrderLambda: createOrderLambda.function,
    //   updateOrderStatusLambda: updateOrderStatusLambda.function,
    // });

    // TODO: Add DynamoDB tables, Lambdas, resolvers, etc. per order-data-layer
  }
}
