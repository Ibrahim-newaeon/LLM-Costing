let claudePromise = null;

function getClaudeModule() {
  if (!claudePromise) {
    claudePromise = (async () => {
      const [jsonMod, wasmMod, initMod] = await Promise.all([
        import('@anthropic-ai/tokenizer/dist/cjs/claude.json'),
        import('tiktoken/lite/tiktoken_bg.wasm?url'),
        import('tiktoken/lite/init'),
      ]);
      const data = jsonMod.default;
      const wasmUrl = wasmMod.default;
      await initMod.init(async (imports) => {
        const buf = await (await fetch(wasmUrl)).arrayBuffer();
        return WebAssembly.instantiate(buf, imports);
      });
      return { data, Tiktoken: initMod.Tiktoken };
    })();
  }
  return claudePromise;
}

export async function countClaudeTokens(text) {
  const { data, Tiktoken } = await getClaudeModule();
  const tk = new Tiktoken(data.bpe_ranks, data.special_tokens, data.pat_str);
  try {
    return tk.encode(text.normalize('NFKC'), 'all').length;
  } finally {
    tk.free();
  }
}

export async function countTokensByTokenizer(tokenizer, text) {
  if (!text) return 0;
  switch (tokenizer) {
    case 'claude':
      return countClaudeTokens(text);
    case 'llama': {
      const m = await import('llama-tokenizer-js');
      return m.default.encode(text).length;
    }
    case 'cl100k': {
      const m = await import('gpt-tokenizer/encoding/cl100k_base');
      return m.encode(text).length;
    }
    case 'o200k':
    default: {
      const m = await import('gpt-tokenizer/encoding/o200k_base');
      return m.encode(text).length;
    }
  }
}