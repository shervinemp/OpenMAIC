import { VectorStoreIndex, storageContextFromDefaults } from "llamaindex";

export async function getContextForSlide(topic: string, classroomId: string): Promise<string> {
  const persistDir = `./.openmaic/vector_cache/${classroomId}`;

  // 1. Re-load the storage context from the local JSON files on your hard drive
  const storageContext = await storageContextFromDefaults({
    persistDir,
  });

  // 2. Rehydrate the index from the local storage
  // We pass an empty array of nodes because they are already saved in the storageContext
  const index = await VectorStoreIndex.init({
    nodes: [],
    storageContext
  });

  // 3. Build the advanced Query Engine (you can easily add rerankers here later)
  const queryEngine = index.asQueryEngine({
    similarityTopK: 5,
  });

  // 4. Query the local vector files for the specific slide topic
  const response = await queryEngine.query({ query: topic });

  return response.response;
}
