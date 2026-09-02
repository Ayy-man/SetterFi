/**
 * Normalized GHL provisioning contracts for the onboarding runner.
 *
 * Requests contain only the fields orchestration owns, and responses contain stable references
 * rather than raw provider envelopes or credentials. Provider parsing remains in the GHL module.
 */

import type { A2pProbeResult, ProvisioningStep } from "./contracts";

export type ProvisioningContext = {
  tenantId: string;
  stepKey: ProvisioningStep;
  idempotencyKey: string;
};

export type PostalAddress = {
  line1: string;
  line2?: string;
  city: string;
  region: string;
  postalCode: string;
};

export type GhlLocationRequest = {
  companyId: string;
  name: string;
  timezone: string;
  country: string;
  address: PostalAddress;
  snapshotId: string;
};

export type GhlLocation = {
  locationId: string;
  companyId: string;
  rawReference: string;
};

export type GhlSnapshotRequest = {
  locationId: string;
  snapshotId: string;
  companyId: string;
};

export type GhlSnapshotStatus = {
  pending: readonly string[];
  completed: readonly string[];
  providerStatus: string;
};

export type GhlNumberRequest = {
  locationId: string;
  poolId?: string;
  areaCode?: string;
};

export type PurchasedNumber = {
  numberRef: string;
  maskedNumber: string;
  locationId: string;
  underLcAccount: boolean;
};

export type ApprovedA2pInput = {
  artifactId: string;
  businessProfileId: string;
  artifactHash: string;
};

export type ApprovedCampaignInput = {
  artifactId: string;
  contentScreenId: string;
  campaignDescriptionHash: string;
  sampleMessagesHash: string;
};

export type A2pSubmission = {
  submissionRef: string;
  submittedAt: string;
  state: "submitted";
};

export type OwnedProbeInput = {
  targetHash: string;
  probeKey: string;
};

export type GhlProvisioningDriver = {
  createOrFindLocation(
    context: ProvisioningContext,
    request: GhlLocationRequest,
  ): Promise<GhlLocation>;
  getSnapshotStatus(
    context: ProvisioningContext,
    request: GhlSnapshotRequest,
  ): Promise<GhlSnapshotStatus>;
  purchaseOrFindNumber(
    context: ProvisioningContext,
    request: GhlNumberRequest,
  ): Promise<PurchasedNumber>;
  submitBrand(
    context: ProvisioningContext,
    input: ApprovedA2pInput,
  ): Promise<A2pSubmission>;
  submitCampaign(
    context: ProvisioningContext,
    input: ApprovedCampaignInput,
  ): Promise<A2pSubmission>;
  probeOwnedTarget(
    context: ProvisioningContext,
    input: OwnedProbeInput,
  ): Promise<A2pProbeResult>;
};
