import { countTokens as claudeCount } from '@anthropic-ai/tokenizer';
import llamaTokenizer from 'llama-tokenizer-js';
import { encode as encO200k, countTokens as countO200k } from 'gpt-tokenizer';
import { encode as encCl100k } from 'gpt-tokenizer/encoding/cl100k_base';
import { encode as encR50k } from 'gpt-tokenizer/encoding/r50k_base';

const text = "Hello, world! This is a token count test. The quick brown fox jumps over 123 lazy dogs. \u{1F985} emoji and café naïve text!";

try { console.log('claude:', claudeCount(text)); } catch (e) { console.log('claude error:', e.message); }
console.log('llama:', llamaTokenizer.encode(text).length, llamaTokenizer.encode(text).slice(0,4));
console.log('o200k:', encO200k(text).length, encO200k(text).slice(0,4));
console.log('cl100k:', encCl100k(text).length);
console.log('r50k:', encR50k(text).length);
