// Runs one Code node of a generated workflow outside n8n, with fake n8n globals, so glue code is testable.
//   nodes:  output of other nodes by name, for $('Node').first().json. A node that did not run (or whose output 0
//           is empty) is simply absent, and $() throws for it like n8n does.
//   input:  the item the node receives, $input.first().json.
import { createRequire } from 'node:module';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const require = createRequire(import.meta.url);

export async function runCodeNode(workflow, nodeName, { input = {}, nodes = {}, env = {}, executionId = '77' } = {}) {
  const node = workflow.nodes.find(candidate => candidate.name === nodeName);
  if (!node) throw new Error(`No node named ${nodeName}`);
  const lookup = name => {
    if (!(name in nodes)) throw new Error(`Node '${name}' hasn't been executed`);
    return { first: () => ({ json: JSON.parse(JSON.stringify(nodes[name])) }) };
  };
  const run = new AsyncFunction('$', '$input', '$env', '$execution', '$getWorkflowStaticData', 'require', node.parameters.jsCode);
  const items = await run.call({ helpers: {} }, lookup, { first: () => ({ json: JSON.parse(JSON.stringify(input)) }) }, env, { id: executionId }, () => ({}), require);
  return items.map(item => item.json);
}
