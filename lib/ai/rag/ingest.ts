import { Document, VectorStoreIndex, storageContextFromDefaults } from "llamaindex";
import * as fs from "fs/promises";

export async function ingestTextToDatabase(text: string, classroomId: string) {
  // 1. Define the local folder where this classroom's vector data will live
  const persistDir = `./.openmaic/vector_cache/${classroomId}`;

  // Ensure the directory exists on your laptop
  await fs.mkdir(persistDir, { recursive: true });

  // 2. Initialize the native, zero-dependency storage context
  // This automatically sets up SimpleVectorStore, SimpleDocumentStore, etc.
  const storageContext = await storageContextFromDefaults({
    persistDir,
  });

  // 3. Wrap the extracted textbook text into a LlamaIndex Document
  const doc = new Document({ text, id_: classroomId });

  // 4. Chunk, embed, and save to your local hard drive automatically
  await VectorStoreIndex.fromDocuments([doc], {
    storageContext
  });

  console.log(`Successfully embedded and stored knowledge for classroom ${classroomId}`);
}
