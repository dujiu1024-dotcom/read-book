import test from "node:test";
import assert from "node:assert/strict";
import { hasEncryptedBackupService, hasGenerationService } from "./reader-capabilities.js";

const tokenProvider = async () => "token";

test("Agent generation can be configured independently of encrypted backup", () => {
  const config = {
    localDataSetId: "dataset-1",
    generationApiBaseUrl: "https://generation.example",
  };
  assert.equal(hasGenerationService(config, tokenProvider), true);
  assert.equal(hasEncryptedBackupService(config), false);
});

test("backup configuration does not imply Agent generation configuration", () => {
  const config = {
    localDataSetId: "dataset-1",
    encryptedBackupPort: {
      uploadSnapshot: async () => ({ backupId: "backup-1" }),
      listBackups: async () => [],
      restoreToRepository: async () => true,
    },
  };
  assert.equal(hasGenerationService(config, tokenProvider), false);
  assert.equal(hasEncryptedBackupService(config), true);
});

test("a partial custom backup port is not considered configured", () => {
  assert.equal(hasEncryptedBackupService({
    encryptedBackupPort: { uploadSnapshot: async () => ({ backupId: "backup-1" }) },
  }), false);
});

test("both capabilities require their own complete configuration", () => {
  const config = {
    localDataSetId: "dataset-1",
    apiBaseUrl: "https://api.example",
  };
  assert.equal(hasGenerationService(config, tokenProvider), true);
  assert.equal(hasEncryptedBackupService(config), true);
  assert.equal(hasGenerationService(config, null), false);
});
