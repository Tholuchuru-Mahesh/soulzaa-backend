export interface VerificationResult {
  isVerified: boolean;
  providerTxnId: string;
  amountVerified?: number;
  currencyVerified?: string;
  errorMessage?: string;
  rawPayload?: any;
  /** Store product ID the purchase was actually for. Checked against the order's package. */
  productId?: string;
  /** Provider purchase state. Google: 0 purchased, 1 cancelled, 2 pending. */
  purchaseState?: number;
  /** Provider consumption state. Google: 0 yet to be consumed, 1 consumed. */
  consumptionState?: number;
  /** Account the purchase was bound to at checkout. Checked against the order's user. */
  externalAccountId?: string;
}

export interface IPaymentProviderAdapter {
  verifyReceipt(receiptData: string, signature?: string, order?: any): Promise<VerificationResult>;
}
