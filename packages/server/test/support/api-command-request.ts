/** Public mutation wire shape; fixtures may retain retry ids beside internal command values. */
export function apiCommand(body: unknown) {
  const value = body as { requestId?: string };
  return {
    headers: {
      "Content-Type": "application/json",
      ...(value?.requestId ? { "Idempotency-Key": value.requestId } : {}),
    },
    body: JSON.stringify(
      body && typeof body === "object"
        ? Object.fromEntries(
            Object.entries(body).filter(([key]) => key !== "requestId"),
          )
        : body,
    ),
  };
}
