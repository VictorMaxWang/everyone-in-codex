import assert from "node:assert/strict";
import test from "node:test";

import { assertCodexAppServerSchema } from "../src/codex-schema-contract.mjs";

test("Codex app-server schema 门禁要求 tagged File Change 与原生审批方法", () => {
  const schema = {
    definitions: {
      v2: {
        PatchChangeKind: {
          oneOf: [
            { properties: { type: { enum: ["add"] } } },
            { properties: { type: { enum: ["delete"] } } },
            { properties: { type: { enum: ["update"] }, move_path: { type: ["string", "null"] } } },
          ],
        },
      },
      methods: [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "commandActions",
      ],
    },
  };
  assert.equal(assertCodexAppServerSchema(schema), true);
  assert.throws(
    () => assertCodexAppServerSchema({ definitions: { v2: { PatchChangeKind: { oneOf: [] } } } }),
    /patch_schema_incompatible/,
  );
});
