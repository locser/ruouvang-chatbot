/**
 * Embedding Service: Generates 1536-dimensional L2-normalized vector embeddings for text chunks and RAG queries.
 * Uses a deterministic term-hashing trick projected into 1536D vector space for pgvector similarity search.
 */
export async function taoVectorEmbedding(text: string): Promise<number[]> {
  const DIMENSIONS = 1536;
  const vector: number[] = new Array(DIMENSIONS).fill(0);

  // Normalize text
  const cleanText = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ");
  const words = cleanText.split(/\s+/).filter(Boolean);

  if (words.length === 0) {
    // Return zero unit vector if empty
    vector[0] = 1.0;
    return vector;
  }

  // Feature hashing: hash words and 2-grams into 1536 dimensions
  const tokens: string[] = [...words];
  for (let i = 0; i < words.length - 1; i++) {
    tokens.push(`${words[i]}_${words[i + 1]}`);
  }

  for (const token of tokens) {
    let hash = 5381;
    for (let j = 0; j < token.length; j++) {
      hash = (hash * 33) ^ token.charCodeAt(j);
    }
    const index = Math.abs(hash) % DIMENSIONS;
    const sign = hash % 2 === 0 ? 1 : -1;
    vector[index] += sign;
  }

  // Calculate L2 norm and normalize vector to unit length
  const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
  if (magnitude === 0) {
    vector[0] = 1.0;
    return vector;
  }

  return vector.map((val) => val / magnitude);
}
