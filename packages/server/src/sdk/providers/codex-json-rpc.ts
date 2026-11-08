export type JsonRpcId = string | number;

export interface JsonRpcError {
  message?: string;
  code?: number;
  data?: unknown;
}

export interface JsonRpcResponse {
  id?: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface JsonRpcServerRequest extends JsonRpcNotification {
  id: JsonRpcId;
}
