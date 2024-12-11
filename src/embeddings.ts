import { OpenAI } from "openai";
import { Pinecone } from "@pinecone-database/pinecone";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getAllFiles } from "./fs";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY! || "pcsk_51Upcq_Q44zMdMewSaqfH7iWdpg4opkR2T41ENjyQtK2LNhZh8nbtZGkZMGkCocnYMfMuT",
  environment: process.env.PINECONE_ENVIRONMENT! || "us-east-1-aws",
});

const index = pinecone.index(process.env.PINECONE_INDEX_NAME! || "semantic-fs");

export async function generateEmbedding(text: string) {
  const response = await openai.embeddings.create({
    input: text,
    model: "text-embedding-ada-002",
  });
  return response.data[0].embedding;
}

export async function upsertEmbeddings(filePath: string) {
  console.log("Upserting embeddings for file:", filePath);
  const content = await readFile(filePath, 'utf-8');
  const fileName = path.basename(filePath);
  
  const embedding = await generateEmbedding(content);
  
  await index.upsert([{
    id: filePath,
    values: embedding,
    metadata: {
      fileName,
      filePath,
      content
    }
  }]);
  
  return { message: `Successfully embedded file: ${fileName}` };
}

export async function upsertDirectoryEmbeddings(dirPath: string) {
  const files = await getAllFiles(dirPath);
  const results = [];
  
  for (const file of files) {
    try {
      const result = await upsertEmbeddings(file);
      results.push(result);
    } catch (error) {
      results.push({ error: `Failed to embed ${file}: ${error}` });
    }
  }
  
  return results;
}

export async function semanticSearch(query: string, limit: number = 5) {
  const queryEmbedding = await generateEmbedding(query);
  
  const searchResults = await index.query({
    vector: queryEmbedding,
    topK: limit,
    includeMetadata: true
  });
  
  return searchResults.matches.map(match => ({
    filePath: match.metadata?.filePath,
    fileName: match.metadata?.fileName,
    score: match.score,
    content: match.metadata?.content
  }));
} 