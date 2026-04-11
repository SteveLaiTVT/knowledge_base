import { MinimalCodexAgent } from "../src/index.js";

async function main() {
  const agent = new MinimalCodexAgent();

  const result1 = await agent.run("Make a plan to diagnose and fix the CI failures");
  console.log("result1:", result1);

  const result2 = await agent.continue("Implement the plan");
  console.log("result2:", result2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
