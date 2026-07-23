import { PaymentProvider } from '@prisma/client';

export interface VerificationResult {
  isVerified: boolean;
  providerTxnId: string;
  amountVerified?: number;
  currencyVerified?: string;
  errorMessage?: string;
  rawPayload?: any;
}

export interface IPaymentProviderAdapter {
  verifyReceipt(receiptData: string, signature?: string, order?: any): Promise<VerificationResult>;
}
