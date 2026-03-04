import * as cdk from "aws-cdk-lib";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import type { Construct } from "constructs";
import type { DomainStackProps } from "./domain-stack-props";
import { OrderAppSyncConstruct } from "./constructs/appsync/order-appsync/order-appsync-construct";
import { OrderStateMachineConstruct } from "./constructs/stepfunctions/order-state-machine/order-state-machine-construct";
import { OrderTablesConstruct } from "./constructs/dynamodb/order-tables/order-tables-construct";
import { CartTablesConstruct } from "./constructs/dynamodb/cart-tables/cart-tables-construct";
import { OutboxTableConstruct } from "./constructs/dynamodb/outbox-table/outbox-table-construct";
import { importEventBusFromSharedInfra, getEventBusArnFromSharedInfra } from "./utils/eventbridge-helper";
import { RepublishLambdaConstruct } from "./constructs/lambda/republish/republish-lambda-construct";
import { ExpireStockHoldsLambdaConstruct } from "./constructs/lambda/scheduled/expire-stock-holds-lambda-construct";
import { CreateOrderLambdaConstruct } from "./constructs/lambda/order/create-order/create-order-lambda-construct";
import { UpdateOrderStatusLambdaConstruct } from "./constructs/lambda/order/update-order-status/update-order-status-lambda-construct";
import { CancelOrderLambdaConstruct } from "./constructs/lambda/order/cancel-order/cancel-order-lambda-construct";
import { GetOrderLambdaConstruct } from "./constructs/lambda/order/get-order/get-order-lambda-construct";
import { ListOrdersLambdaConstruct } from "./constructs/lambda/order/list-orders/list-orders-lambda-construct";
import { AddShippingTrackingLambdaConstruct } from "./constructs/lambda/order/add-shipping-tracking/add-shipping-tracking-lambda-construct";
import { ConfirmStockHoldsLambdaConstruct } from "./constructs/lambda/order/confirm-stock-holds/confirm-stock-holds-lambda-construct";
import { PaymentCapturedConsumerLambdaConstruct } from "./constructs/lambda/order/payment-captured-consumer/payment-captured-consumer-lambda-construct";
import { CartOperationsLambdaConstruct } from "./constructs/lambda/cart/cart-operations-lambda-construct";
import { OrderAppSyncResolversConstruct } from "./constructs/appsync/order-appsync-resolvers/order-appsync-resolvers-construct";

export class OrderDomainStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DomainStackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add("Domain", "hand-made-order-domain");
    cdk.Tags.of(this).add("Environment", props.environment);
    cdk.Tags.of(this).add("Project", "hand-made");
    cdk.Tags.of(this).add("Region", props.regionCode);
    cdk.Tags.of(this).add("StackName", this.stackName);

    const removalPolicy = props.environment === 'prod'
      ? cdk.RemovalPolicy.RETAIN
      : cdk.RemovalPolicy.DESTROY;

    // Step 1: Import shared EventBridge bus
    const sharedEventBus = importEventBusFromSharedInfra(this, props.environment);
    const eventBusArn = getEventBusArnFromSharedInfra(this, props.environment);
    const schemaRegistryName = ssm.StringParameter.valueForStringParameter(
      this,
      `/hand-made/${props.environment}/shared-infra/schema-registry-name`,
    );
    
    // Get EventBus name from SSM for passing to lambdas
    const eventBusName = ssm.StringParameter.fromStringParameterName(
      this,
      'EventBusNameParameter',
      `/${props.environment}/shared-infra/eventbridge/event-bus-name`
    ).stringValue;

    // Import shelf items table from Discovery Domain (optional - may not exist yet)
    let shelfItemsTable: dynamodb.ITable | undefined;
    try {
      const shelfItemsTableName = ssm.StringParameter.valueForStringParameter(
        this,
        `/${props.environment}/shelf-discovery-domain/dynamodb/shelf-items-table-name`
      );
      if (shelfItemsTableName) {
        shelfItemsTable = dynamodb.Table.fromTableName(
          this,
          'ShelfItemsTableImport',
          shelfItemsTableName
        );
      }
    } catch (err) {
      console.log('Shelf items table not available in SSM yet, cart validation will fail at runtime');
    }

    // Step 2: Create DynamoDB tables
    const orderTables = new OrderTablesConstruct(this, "OrderTables", {
      environment: props.environment,
      regionCode: props.regionCode,
      removalPolicy,
    });

    const outboxTable = new OutboxTableConstruct(this, "OutboxTable", {
      environment: props.environment,
      regionCode: props.regionCode,
      domainName: "order-domain",
      removalPolicy,
    });

    // Step 2.5: Create Cart tables for shopping cart
    const cartTables = new CartTablesConstruct(this, "CartTables", {
      environment: props.environment,
      regionCode: props.regionCode,
    });

    new RepublishLambdaConstruct(this, "RepublishLambda", {
      environment: props.environment,
      regionCode: props.regionCode,
      domainName: "order-domain",
      outboxTable: outboxTable.table,
      eventBus: sharedEventBus,
      schemaRegistryName,
      removalPolicy,
    });

    // Step 2.6: Create scheduled lambda to expire stock holds (runs every 5 minutes)
    new ExpireStockHoldsLambdaConstruct(this, "ExpireStockHolds", {
      environment: props.environment,
      regionCode: props.regionCode,
      stockHoldsTable: orderTables.stockHoldsTable,
      outboxTable: outboxTable.table,
    });

    // Step 3: Create Step Functions State Machine
    const orderStateMachine = new OrderStateMachineConstruct(this, "OrderStateMachine", {
      environment: props.environment,
      regionCode: props.regionCode,
      ordersTable: orderTables.ordersTable,
      orderItemsTable: orderTables.orderItemsTable,
      eventBus: sharedEventBus,
    });

    // Step 4: Create Lambda functions (DynamoDB-backed)
    const createOrderLambda = new CreateOrderLambdaConstruct(this, "CreateOrderLambda", {
      environment: props.environment,
      regionCode: props.regionCode,
      ordersTable: orderTables.ordersTable,
      orderItemsTable: orderTables.orderItemsTable,
      stockHoldsTable: orderTables.stockHoldsTable,
      outboxTable: outboxTable.table,
      eventBusArn,
      eventBusName,
      removalPolicy,
    });

    const updateOrderStatusLambda = new UpdateOrderStatusLambdaConstruct(this, "UpdateOrderStatusLambda", {
      environment: props.environment,
      regionCode: props.regionCode,
      ordersTable: orderTables.ordersTable,
      removalPolicy,
    });

    const cancelOrderLambda = new CancelOrderLambdaConstruct(this, "CancelOrderLambda", {
      environment: props.environment,
      regionCode: props.regionCode,
      ordersTable: orderTables.ordersTable,
      removalPolicy,
    });

    const getOrderLambda = new GetOrderLambdaConstruct(this, "GetOrderLambda", {
      environment: props.environment,
      regionCode: props.regionCode,
      ordersTable: orderTables.ordersTable,
      orderItemsTable: orderTables.orderItemsTable,
      removalPolicy,
    });

    const listOrdersLambda = new ListOrdersLambdaConstruct(this, "ListOrdersLambda", {
      environment: props.environment,
      regionCode: props.regionCode,
      ordersTable: orderTables.ordersTable,
      removalPolicy,
    });

    const addShippingTrackingLambda = new AddShippingTrackingLambdaConstruct(this, "AddShippingTrackingLambda", {
      environment: props.environment,
      regionCode: props.regionCode,
      ordersTable: orderTables.ordersTable,
      removalPolicy,
    });

    // Step 4.5: Create Cart Operations Lambdas (add/remove/validate/checkout)
    const cartOperations = new CartOperationsLambdaConstruct(this, "CartOperations", {
      environment: props.environment,
      regionCode: props.regionCode,
      cartTable: cartTables.cartTable,
      cartIdempotencyTable: cartTables.cartIdempotencyTable,
      shelfItemsTable, // Optional - from Discovery domain
      stockHoldsTable: orderTables.stockHoldsTable,
      ordersTable: orderTables.ordersTable,
      outboxTable: outboxTable.table,
    });
    
    // Set EVENT_BUS_NAME env var for cart operations lambdas
    [
      cartOperations.addToCartFunction,
      cartOperations.getCartFunction,
      cartOperations.removeFromCartFunction,
      cartOperations.validateCartFunction,
      cartOperations.checkoutFunction,
    ].forEach(fn => {
      fn.addEnvironment('EVENT_BUS_NAME', eventBusName);
    });

    // Step 4.6: Create Confirm Stock Holds Lambda (triggered by payment.captured event)
    const confirmStockHoldsLambda = new ConfirmStockHoldsLambdaConstruct(this, "ConfirmStockHoldsLambda", {
      environment: props.environment,
      regionCode: props.regionCode,
      stockHoldsTable: orderTables.stockHoldsTable,
      ordersTable: orderTables.ordersTable,
      outboxTable: outboxTable.table,
      eventBusArn,
      removalPolicy,
    });
    confirmStockHoldsLambda.function.addEnvironment('EVENT_BUS_NAME', eventBusName);

    // Step 4.7: Create Payment Captured Consumer Lambda (handles payment.captured events)
    const paymentCapturedConsumerLambda = new PaymentCapturedConsumerLambdaConstruct(this, "PaymentCapturedConsumerLambda", {
      environment: props.environment,
      regionCode: props.regionCode,
      ordersTable: orderTables.ordersTable,
      outboxTable: outboxTable.table,
      eventBusArn,
      removalPolicy,
    });
    paymentCapturedConsumerLambda.function.addEnvironment('EVENT_BUS_NAME', eventBusName);

    // Step 4.8: Create EventBridge Rules to trigger payment event handlers
    // Rule 1: payment.captured.v1 → confirm-stock-holds-lambda
    const paymentCapturedRule = new events.Rule(this, 'PaymentCapturedRule', {
      eventBus: sharedEventBus,
      eventPattern: {
        source: ['hand-made.payment-domain'],
        detailType: ['payment.captured.v1'],
      },
      description: 'Trigger confirm stock holds on payment captured',
    });
    paymentCapturedRule.addTarget(new targets.LambdaFunction(confirmStockHoldsLambda.function));

    // Rule 2: payment.captured.v1 → payment-captured-consumer-lambda
    const paymentCapturedConsumerRule = new events.Rule(this, 'PaymentCapturedConsumerRule', {
      eventBus: sharedEventBus,
      eventPattern: {
        source: ['hand-made.payment-domain'],
        detailType: ['payment.captured.v1'],
      },
      description: 'Trigger order status update on payment captured',
    });
    paymentCapturedConsumerRule.addTarget(new targets.LambdaFunction(paymentCapturedConsumerLambda.function));

    // Step 5: Create AppSync GraphQL API
    const orderAppSync = new OrderAppSyncConstruct(this, "OrderAppSync", {
      environment: props.environment,
      regionCode: props.regionCode,
    });

    // Step 6: Connect Lambda functions to AppSync resolvers
    const orderResolvers = new OrderAppSyncResolversConstruct(this, "OrderResolvers", {
      api: orderAppSync.api,
      createOrderLambda: createOrderLambda.function,
      updateOrderStatusLambda: updateOrderStatusLambda.function,
      cancelOrderLambda: cancelOrderLambda.function,
      getOrderLambda: getOrderLambda.function,
      listOrdersLambda: listOrdersLambda.function,
      addShippingTrackingLambda: addShippingTrackingLambda.function,
    });

    // Export Orders table name to SSM for cross-stack references (e.g., Payout Domain)
    new ssm.StringParameter(this, 'OrdersTableNameParameter', {
      parameterName: `/${props.environment}/order-domain/dynamodb/orders-table-name`,
      stringValue: orderTables.ordersTable.tableName,
      description: 'Orders DynamoDB Table Name',
    });
  }
}
