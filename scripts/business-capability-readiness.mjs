import { getWorkflowBusinessReadiness } from "../server/workflowBusinessReadiness.js";

globalThis.process.stderr.write("Evaluating current-policy real workflow tasks (cached unchanged tasks are reused)...\n");
const report = await getWorkflowBusinessReadiness();
console.log(JSON.stringify(report, null, 2));
globalThis.process.exit(report.ready ? 0 : 1);
