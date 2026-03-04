#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { OrderDomainStack } from "../lib/order-domain-stack";
import { OrderDomainPipelineStack } from "../lib/order-domain-pipeline-stack";

const app = new cdk.App();

const environment = process.env.ENVIRONMENT ?? app.node.tryGetContext("environment") ?? "dev";
const regionCode = process.env.REGION_CODE ?? app.node.tryGetContext("regionCode") ?? "use1";

// Account mapping based on environment
const accountMapping: Record<string, string> = {
  dev: "741429964649",
  mimic: "329177708881",
  prod: "021657748325",
};

const targetAccount = accountMapping[environment] ?? process.env.CDK_DEFAULT_ACCOUNT;

new OrderDomainStack(app, `${environment}-${regionCode}-hand-made-order-domain-stack`, {
  env: {
    account: targetAccount,
    region: process.env.AWS_REGION ?? process.env.CDK_DEFAULT_REGION ?? "us-east-1",
  },
  environment,
  regionCode,
});

// Domain-scoped pipeline infrastructure
const managementAccountId = "567608120268";
const devAccountId = "741429964649";
const mimicProdAccountId = "329177708881";
const prodAccountId = "021657748325";
const githubConnectionArn = "arn:aws:codestar-connections:us-east-1:567608120268:connection/ef226671-d921-4f3e-9935-c5f2549ecb0d";

new OrderDomainPipelineStack(
  app,
  "OrderDomainPipelineStack",
  {
    env: { account: managementAccountId, region: "us-east-1" },
    domain: "order-domain",
    managementAccountId,
    devAccountId,
    mimicProdAccountId,
    prodAccountId,
    githubConnectionArn,
    description: "Domain-scoped pipeline for order-domain",
  }
);

app.synth();
