import { registerWorker } from "iii-sdk";
import { StateKV } from "../../src/state/kv.js";
import { DedupMap } from "../../src/functions/dedup.js";
import { registerObserveFunction } from "../../src/functions/observe.js";
import { registerSearchFunction } from "../../src/functions/search.js";
import { registerSummarizeFunction } from "../../src/functions/summarize.js";
import { registerApiTriggers } from "../../src/triggers/api.js";
import { registerEventTriggers } from "../../src/triggers/events.js";

const sdk = registerWorker(process.env.III_ENGINE_URL!, { workerName: "devspace-test", invocationTimeoutMs: 30_000 });
const kv = new StateKV(sdk);
registerObserveFunction(sdk, kv, new DedupMap());
registerSearchFunction(sdk, kv);
registerSummarizeFunction(sdk, kv, {
  name: "local-test-provider",
  compress: async () => { throw new Error("unexpected compression call"); },
  summarize: async () => "<summary><title>DevSpace tools</title><narrative>Recorded local workspace operations from the DevSpace integration test.</narrative><decisions><decision>Use event UUIDs for durable deduplication.</decision></decisions><files></files><concepts><concept>DevSpace</concept></concepts></summary>",
});
registerApiTriggers(sdk, kv);
registerEventTriggers(sdk, kv);
