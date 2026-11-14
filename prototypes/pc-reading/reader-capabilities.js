export function hasGenerationService(config = {}, getAccessToken = config.getAccessToken) {
  const generationUrl = config.generationApiBaseUrl || config.apiBaseUrl;
  return Boolean(
    typeof config.localDataSetId === "string" && config.localDataSetId.trim() &&
    typeof getAccessToken === "function" &&
    typeof generationUrl === "string" && generationUrl.trim()
  );
}

export function hasEncryptedBackupService(config = {}) {
  if (typeof config.createEncryptedBackupPort === "function") return true;
  const port = config.encryptedBackupPort;
  if (port &&
      typeof port.uploadSnapshot === "function" &&
      typeof port.listBackups === "function" &&
      typeof port.restoreToRepository === "function") return true;
  return typeof config.apiBaseUrl === "string" && config.apiBaseUrl.trim().length > 0;
}
