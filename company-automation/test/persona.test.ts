import assert from "node:assert/strict";
import test from "node:test";
import {
  createPersona,
  deriveWindowsHardware,
  serializePersona,
} from "../src/persona.js";

test("Windows hardware derivation is deterministic and catalog-bound", () => {
  assert.deepEqual(
    deriveWindowsHardware(12_345),
    deriveWindowsHardware(12_345),
  );
  const value = deriveWindowsHardware(12_345);
  assert.ok([4, 6, 8, 12, 16, 20, 24].includes(value.hardwareConcurrency));
  assert.ok([4, 8, 16, 32].includes(value.deviceMemoryGiB));
});
test("persona serialization is compact and LF terminated", () => {
  const persona = createPersona("0aa52f11-f736-44cb-8e80-35381210198a", 54_321);
  const serialized = serializePersona(persona);
  assert.equal(serialized.endsWith("\n"), true);
  assert.equal(serialized.trim(), JSON.stringify(persona));
});
test("invalid seeds fail closed", () => {
  assert.throws(() => deriveWindowsHardware(9999));
  assert.throws(() => deriveWindowsHardware(100000));
});
