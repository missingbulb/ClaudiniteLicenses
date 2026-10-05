// The producer half of the writes queue: the key Worker cannot write D1, so its incidents go to the
// sync Worker as messages, sent after the answer so a key never waits.
import type { WriteMessage } from "../../../packages/licensing/src/index.ts";

export function enqueueWrites(env: { WRITES?: Queue }, ctx: ExecutionContext, messages: WriteMessage[]): void {
  if (messages.length === 0) return;
  const send = async () => {
    try {
      if (!env.WRITES) throw new Error("no WRITES binding");
      await env.WRITES.sendBatch(messages.map((body) => ({ body })));
    } catch (err) {
      console.log(JSON.stringify({ marker: "queue-send-failed", kinds: messages.map((m) => m.kind), error: String(err) }));
    }
  };
  ctx.waitUntil(send());
}
