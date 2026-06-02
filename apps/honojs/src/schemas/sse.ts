export type SseDelta = {
  type: "delta";
  chatId: string;
  turnId: string;
  delta: string;
  accumulated: string;
};

export type SseTextDone = {
  type: "text_done";
  chatId: string;
  turnId: string;
  text: string;
};

export type SseCompleted = {
  type: "completed";
  chatId: string;
  turnId: string;
  responseId?: string;
  outputItems: unknown[];
  text: string;
};

export type SseError = {
  type: "error";
  chatId: string;
  message: string;
};

export type SseEvent = SseDelta | SseTextDone | SseCompleted | SseError;

export type SseRequestParams = {
  input: unknown[];
  model?: string;
  instructions?: string;
  previousResponseId?: string;
  environmentId?: string;
  images?: { data: string; mimeType: string }[];
};
