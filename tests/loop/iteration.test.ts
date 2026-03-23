import { expect, test } from "bun:test";
import { iterationCooldown } from "../../src/loop/iteration";

test("iterationCooldown reads LOOP_COOLDOWN_MS at call time", async () => {
  const original = process.env.LOOP_COOLDOWN_MS;
  process.env.LOOP_COOLDOWN_MS = "0";

  try {
    const result = await Promise.race([
      iterationCooldown(2).then(() => "done"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ]);

    expect(result).toBe("done");
  } finally {
    if (original === undefined) {
      Reflect.deleteProperty(process.env, "LOOP_COOLDOWN_MS");
    } else {
      process.env.LOOP_COOLDOWN_MS = original;
    }
  }
});
