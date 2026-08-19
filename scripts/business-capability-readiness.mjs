import { getWorkflowBusinessReadiness } from "../server/workflowBusinessReadiness.js";

const report = await getWorkflowBusinessReadiness();
console.log(JSON.stringify(report, null, 2));
globalThis.process.exit(report.ready ? 0 : 1);
