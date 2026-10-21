/**
 * Parses a Daraja B2C result/timeout callback (doc 07 §10) down to what the payout service needs:
 * the conversation id (matched to the payout's `external_ref`) and the result code (0 = success).
 * Returns null when the body is not a recognisable B2C result.
 */
export interface B2cResultBody {
  Result?: {
    ResultCode?: number | string;
    ResultDesc?: string;
    ConversationID?: string;
    OriginatorConversationID?: string;
  };
}

export interface ParsedB2cResult {
  conversationId: string;
  resultCode: number;
  resultDesc: string;
}

export function parseB2cResult(body: B2cResultBody): ParsedB2cResult | null {
  const r = body.Result;
  if (!r?.ConversationID || r.ResultCode === undefined || r.ResultCode === null) {
    return null;
  }
  return {
    conversationId: r.ConversationID,
    resultCode: Number(r.ResultCode),
    resultDesc: r.ResultDesc ?? '',
  };
}
