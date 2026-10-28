import { ResponseTooLargeError } from '@ax/core/response-cap';

// A budget for ONE SSE frame, including its field names and delimiters,
// after decompression. 2 MiB allows large argument/reasoning deltas; ordinary
// token deltas are much smaller. There is no total-stream cap: long valid
// generations with many bounded events must keep working.
export const MAX_MODEL_EVENT_BYTES = 2 * 1024 * 1024;

export function capModelFetch(base: typeof fetch | undefined): typeof fetch {
  return async (input, init) => {
    const response = await (base ?? globalThis.fetch)(input, init);
    if (response.body === null || !response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) return response;
    let eventBytes = 0;
    let lineBytes = 0;
    let pendingCR = false;
    let boundaryPending = false;
    const counted = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        for (const byte of chunk) {
          if (pendingCR) {
            pendingCR = false;
            if (byte === 10) {
              if (++eventBytes > MAX_MODEL_EVENT_BYTES) return controller.error(new ResponseTooLargeError(MAX_MODEL_EVENT_BYTES));
              if (boundaryPending) eventBytes = 0;
              boundaryPending = false;
              continue;
            }
            if (boundaryPending) eventBytes = 0;
            boundaryPending = false;
          }
          if (++eventBytes > MAX_MODEL_EVENT_BYTES) return controller.error(new ResponseTooLargeError(MAX_MODEL_EVENT_BYTES));
          if (byte === 13) {
            pendingCR = true;
            boundaryPending = lineBytes === 0;
            lineBytes = 0;
          } else if (byte === 10) {
            if (lineBytes === 0) eventBytes = 0;
            lineBytes = 0;
          } else {
            lineBytes++;
          }
        }
        controller.enqueue(chunk);
      },
    }));
    // Provider readers use status and headers, not the reason phrase. Omitting
    // it also accepts HTTP reason phrases that the Response constructor rejects.
    return new Response(counted, { status: response.status, headers: response.headers });
  };
}
