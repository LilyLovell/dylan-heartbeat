const { createClient } = require('@supabase/supabase-js');

// 连接supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// 把文字变成向量
async function getEmbedding(text) {
  const response = await fetch('https://api.siliconflow.cn/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.SILICONFLOW_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.EMBEDDING_MODEL,
      input: text
    })
  });

  const data = await response.json();
  return data.data[0].embedding;
}

// 存一条记忆
async function storeMemory(content, metadata = {}) {
  const embedding = await getEmbedding(content);

  const { error } = await supabase
    .from('memories')
    .insert({
      content: content,
      embedding: embedding,
      metadata: metadata
    });

  if (error) console.error('存记忆失败:', error);
  else console.log('记忆已保存:', content.slice(0, 50));
}

// 搜相关记忆
async function searchMemories(query, matchCount = 5) {
  const embedding = await getEmbedding(query);

  const { data, error } = await supabase
    .rpc('match_memories', {
      query_embedding: embedding,
      match_threshold: 0.5,
      match_count: matchCount
    });

  if (error) {
    console.error('搜记忆失败:', error);
    return [];
  }

  return data;
}

module.exports = { storeMemory, searchMemories };