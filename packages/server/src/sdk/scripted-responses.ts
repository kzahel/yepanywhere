/** Shared Responses envelope for owned local model recipes; no inference. */
export function scriptedResponse(
  id: string,
  model: string,
  status: string,
  output: unknown[],
) {
  return {
    id: id,
    object: "response",
    created_at: 1,
    status,
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: {},
    model: model,
    output,
    parallel_tool_calls: true,
    previous_response_id: null,
    store: false,
    temperature: 1,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: 1,
    truncation: "disabled",
    usage: {
      input_tokens: 100,
      output_tokens: 5,
      total_tokens: 105,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
}
