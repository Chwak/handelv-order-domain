import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export interface OrderAppSyncResolversConstructProps {
  api: appsync.IGraphqlApi;
  createOrderLambda?: lambda.IFunction;
  updateOrderStatusLambda?: lambda.IFunction;
  cancelOrderLambda?: lambda.IFunction;
  getOrderLambda?: lambda.IFunction;
  listOrdersLambda?: lambda.IFunction;
  addShippingTrackingLambda?: lambda.IFunction;
  markOrderShippedLambda?: lambda.IFunction;
  markOrderDeliveredLambda?: lambda.IFunction;
}

export class OrderAppSyncResolversConstruct extends Construct {
  constructor(scope: Construct, id: string, props: OrderAppSyncResolversConstructProps) {
    super(scope, id);

    // Create Order Mutation Resolver (invokes Step Functions via Lambda)
    if (props.createOrderLambda) {
      const createOrderDataSource = props.api.addLambdaDataSource(
        'CreateOrderDataSource',
        props.createOrderLambda
      );

      createOrderDataSource.createResolver('CreateOrderResolver', {
        typeName: 'Mutation',
        fieldName: 'createOrder',
        requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
        responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
      });
    }

    // Update Order Status Mutation Resolver
    if (props.updateOrderStatusLambda) {
      const updateOrderStatusDataSource = props.api.addLambdaDataSource(
        'UpdateOrderStatusDataSource',
        props.updateOrderStatusLambda
      );

      updateOrderStatusDataSource.createResolver('UpdateOrderStatusResolver', {
        typeName: 'Mutation',
        fieldName: 'updateOrderStatus',
        requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
        responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
      });
    }

    // Cancel Order Mutation Resolver
    if (props.cancelOrderLambda) {
      const cancelOrderDataSource = props.api.addLambdaDataSource(
        'CancelOrderDataSource',
        props.cancelOrderLambda
      );

      cancelOrderDataSource.createResolver('CancelOrderResolver', {
        typeName: 'Mutation',
        fieldName: 'cancelOrder',
        requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
        responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
      });
    }

    // Query Resolvers
    if (props.getOrderLambda) {
      const getOrderDataSource = props.api.addLambdaDataSource(
        'GetOrderDataSource',
        props.getOrderLambda
      );

      getOrderDataSource.createResolver('GetOrderResolver', {
        typeName: 'Query',
        fieldName: 'getOrder',
        requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
        responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
      });
    }

    if (props.listOrdersLambda) {
      const listOrdersDataSource = props.api.addLambdaDataSource(
        'ListOrdersDataSource',
        props.listOrdersLambda
      );

      listOrdersDataSource.createResolver('ListOrdersResolver', {
        typeName: 'Query',
        fieldName: 'listOrders',
        requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
        responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
      });
    }

    // Additional Mutation Resolvers
    if (props.addShippingTrackingLambda) {
      const addShippingTrackingDataSource = props.api.addLambdaDataSource(
        'AddShippingTrackingDataSource',
        props.addShippingTrackingLambda
      );

      addShippingTrackingDataSource.createResolver('AddShippingTrackingResolver', {
        typeName: 'Mutation',
        fieldName: 'addShippingTracking',
        requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
        responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
      });
    }

    if (props.markOrderShippedLambda) {
      const markOrderShippedDataSource = props.api.addLambdaDataSource(
        'MarkOrderShippedDataSource',
        props.markOrderShippedLambda
      );

      markOrderShippedDataSource.createResolver('MarkOrderShippedResolver', {
        typeName: 'Mutation',
        fieldName: 'markOrderShipped',
        requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
        responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
      });
    }

    if (props.markOrderDeliveredLambda) {
      const markOrderDeliveredDataSource = props.api.addLambdaDataSource(
        'MarkOrderDeliveredDataSource',
        props.markOrderDeliveredLambda
      );

      markOrderDeliveredDataSource.createResolver('MarkOrderDeliveredResolver', {
        typeName: 'Mutation',
        fieldName: 'markOrderDelivered',
        requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
        responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
      });
    }
  }
}
