/**
 * Restrict private cognition data to the active book Thread.
 *
 * A dataset may contain several book Threads, but every Memory is anchored
 * to one Thread and its source messages. Passing versions from another Thread
 * to the evolution planner can create invalid cross-book evolution proposals
 * and can expose unrelated private cognition in the active reader.
 */
export function selectThreadMemoryState(snapshot, threadId) {
  if (!snapshot || typeof snapshot !== "object") {
    throw new TypeError("A repository snapshot is required.");
  }
  if (typeof threadId !== "string" || !threadId.trim()) {
    throw new TypeError("A non-empty Thread ID is required.");
  }

  const memories = (snapshot.memories || []).filter((item) => item.threadId === threadId);
  const memoryIds = new Set(memories.map((item) => item.id));
  const versions = (snapshot.memoryVersions || []).filter((item) => memoryIds.has(item.memoryId));
  const versionIds = new Set(versions.map((item) => item.id));
  const relations = (snapshot.memoryRelations || []).filter((item) =>
    versionIds.has(item.fromVersionId) && versionIds.has(item.toVersionId));
  const pendingCandidates = (snapshot.memoryCandidates || []).filter((item) => item.threadId === threadId);

  return { memories, versions, relations, pendingCandidates };
}
