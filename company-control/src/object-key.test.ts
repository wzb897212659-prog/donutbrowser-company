import assert from "node:assert/strict";
import test from "node:test";
import {
  isProfileCollectionKey,
  profileIdFromObjectKey,
} from "./object-key.js";

const id = "65ad3d6e-e6fa-4b87-9238-7ecf1d3b58af";

test("extracts profile ids from profile and tombstone keys", () => {
  assert.equal(
    profileIdFromObjectKey(`company/profiles/${id}/manifest.json`),
    id,
  );
  assert.equal(profileIdFromObjectKey(`tombstones/profiles/${id}.json`), id);
  assert.equal(profileIdFromObjectKey("groups/all.json"), null);
});

test("identifies profile collection prefixes", () => {
  assert.equal(isProfileCollectionKey("company/profiles/"), true);
  assert.equal(isProfileCollectionKey("proxies/"), false);
});
