export interface JsonlLineRecord {
  line: string;
  terminated: boolean;
}

/** Frame decoded JSONL on LF and identify a final record without one. */
export async function* iterateJsonlRecords(
  chunks: AsyncIterable<string>,
): AsyncIterable<JsonlLineRecord> {
  // Join a record only when complete so a large record is scanned once.
  let pending: string[] = [];
  let firstChunk = true;

  for await (const rawChunk of chunks) {
    const chunk =
      firstChunk && rawChunk.charCodeAt(0) === 0xfeff
        ? rawChunk.slice(1)
        : rawChunk;
    firstChunk = false;
    let offset = 0;
    let newlineIndex = chunk.indexOf("\n");
    while (newlineIndex !== -1) {
      const tail = chunk.slice(offset, newlineIndex);
      let line = tail;
      if (pending.length) {
        pending.push(tail);
        line = pending.join("");
        pending = [];
      }
      yield { line, terminated: true };
      offset = newlineIndex + 1;
      newlineIndex = chunk.indexOf("\n", offset);
    }
    if (offset < chunk.length) pending.push(chunk.slice(offset));
  }

  if (pending.length) {
    yield { line: pending.join(""), terminated: false };
  }
}
