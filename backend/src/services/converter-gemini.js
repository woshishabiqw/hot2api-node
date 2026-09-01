/**
 * Gemini ↔ OpenAI 协议转换器
 */

class GeminiConverter {
  /**
   * OpenAI 请求 → Gemini 请求
   */
  static requestToGemini(openaiBody) {
    const contents = [];
    let systemInstruction = null;

    for (const msg of (openaiBody.messages || [])) {
      if (msg.role === 'system') {
        systemInstruction = { parts: [{ text: msg.content }] };
        continue;
      }

      const role = msg.role === 'assistant' ? 'model' : 'user';
      const parts = [];

      if (typeof msg.content === 'string') {
        parts.push({ text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text') {
            parts.push({ text: part.text });
          } else if (part.type === 'image_url') {
            const url = part.image_url?.url || '';
            if (url.startsWith('data:')) {
              const match = url.match(/^data:([^;]+);base64,(.+)$/);
              if (match) {
                parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
              }
            } else {
              parts.push({ fileData: { mimeType: 'image/jpeg', fileUri: url } });
            }
          }
        }
      }

      // Handle tool calls in assistant messages
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          parts.push({
            functionCall: {
              name: tc.function.name,
              args: JSON.parse(tc.function.arguments || '{}')
            }
          });
        }
      }

      if (parts.length > 0) contents.push({ role, parts });
    }

    // Handle tool results
    for (const msg of (openaiBody.messages || [])) {
      if (msg.role === 'tool') {
        contents.push({
          role: 'user',
          parts: [{
            functionResponse: {
              name: msg.name || msg.tool_call_id,
              response: { content: msg.content }
            }
          }]
        });
      }
    }

    const body = { contents };

    if (systemInstruction) body.systemInstruction = systemInstruction;

    // Generation config
    const genConfig = {};
    if (openaiBody.max_tokens) genConfig.maxOutputTokens = openaiBody.max_tokens;
    if (openaiBody.temperature !== undefined) genConfig.temperature = openaiBody.temperature;
    if (openaiBody.top_p !== undefined) genConfig.topP = openaiBody.top_p;
    if (openaiBody.stop) genConfig.stopSequences = Array.isArray(openaiBody.stop) ? openaiBody.stop : [openaiBody.stop];
    if (Object.keys(genConfig).length > 0) body.generationConfig = genConfig;

    // Tools
    if (openaiBody.tools && Array.isArray(openaiBody.tools)) {
      body.tools = [{
        functionDeclarations: openaiBody.tools.map(t => ({
          name: t.function.name,
          description: t.function.description || '',
          parameters: t.function.parameters || { type: 'object', properties: {} }
        }))
      }];
    }

    return body;
  }

  /**
   * Gemini 响应 → OpenAI 响应 (非流式)
   */
  static responseToOpenai(geminiResponse, model) {
    const candidate = geminiResponse.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const usage = geminiResponse.usageMetadata || {};

    let content = '';
    const toolCalls = [];

    for (const part of parts) {
      if (part.text) content += part.text;
      if (part.functionCall) {
        toolCalls.push({
          id: `call_${Date.now()}_${toolCalls.length}`,
          type: 'function',
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args || {})
          }
        });
      }
    }

    let finishReason = 'stop';
    if (candidate?.finishReason === 'MAX_TOKENS') finishReason = 'length';
    else if (candidate?.finishReason === 'SAFETY') finishReason = 'content_filter';
    else if (toolCalls.length > 0) finishReason = 'tool_calls';

    const message = toolCalls.length > 0
      ? { role: 'assistant', content: content || null, tool_calls: toolCalls }
      : { role: 'assistant', content };

    return {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message,
        finish_reason: finishReason
      }],
      usage: {
        prompt_tokens: usage.promptTokenCount || 0,
        completion_tokens: usage.candidatesTokenCount || 0,
        total_tokens: usage.totalTokenCount || 0
      }
    };
  }

  /**
   * Gemini 流式 chunk → OpenAI 流式 chunk
   */
  static streamChunkToOpenai(chunk, model, state) {
    const candidate = chunk.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const chunks = [];

    for (const part of parts) {
      if (part.text) {
        chunks.push({
          id: state?.chunkId || `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            delta: { content: part.text },
            finish_reason: null
          }]
        });
      }
      if (part.functionCall) {
        chunks.push({
          id: state?.chunkId || `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: `call_${Date.now()}`,
                type: 'function',
                function: {
                  name: part.functionCall.name,
                  arguments: JSON.stringify(part.functionCall.args || {})
                }
              }]
            },
            finish_reason: null
          }]
        });
      }
    }

    // Final chunk with finish reason
    if (candidate?.finishReason) {
      let finishReason = 'stop';
      if (candidate.finishReason === 'MAX_TOKENS') finishReason = 'length';
      else if (candidate.finishReason === 'STOP') finishReason = 'stop';

      chunks.push({
        id: state?.chunkId || `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: finishReason
        }],
        usage: chunk.usageMetadata ? {
          prompt_tokens: chunk.usageMetadata.promptTokenCount || 0,
          completion_tokens: chunk.usageMetadata.candidatesTokenCount || 0,
          total_tokens: chunk.usageMetadata.totalTokenCount || 0
        } : undefined
      });
    }

    return chunks;
  }

  /**
   * OpenAI 流式 chunk → Gemini 流式响应格式
   */
  static streamChunkToGemini(chunk, state) {
    // Gemini streaming uses SSE with JSON payloads
    const delta = chunk.choices?.[0]?.delta;
    const candidate = {
      content: { parts: [], role: 'model' },
      finishReason: null
    };

    // Handle reasoning_content (DeepSeek, OpenAI reasoning models)
    let reasoningText = delta?.reasoning_content?.trim() || '';
    const contentText = delta?.content?.trim() || '';

    // Smart deduplication: if reasoning ends with the same text as content,
    // remove the overlap from reasoning to avoid displaying answer in thinking
    if (reasoningText && contentText) {
      // Find overlap: reasoning ends with content's beginning
      const maxOverlap = Math.min(reasoningText.length, contentText.length);
      for (let i = maxOverlap; i > 0; i--) {
        if (reasoningText.endsWith(contentText.slice(0, i))) {
          reasoningText = reasoningText.slice(0, -i).trim();
          break;
        }
      }
      // Also check if content is fully contained at the end of reasoning
      if (reasoningText.endsWith(contentText)) {
        reasoningText = reasoningText.slice(0, -contentText.length).trim();
      }
    }

    if (reasoningText) {
      candidate.content.parts.push({ text: reasoningText, thought: true });
    }

    // Handle content: only if no reasoning_content (avoid duplicate thinking)
    // or if content has <think> tags that weren't in reasoning_content
    if (contentText) {
      // Check for <think> tags in content (agents that embed thinking in content)
      const thinkMatch = contentText.match(/<think>([\s\S]*?)<\/think>/);
      const thinkingMatch = !thinkMatch && contentText.match(/<thinking>([\s\S]*?)<\/thinking>/);
      const embeddedThink = thinkMatch || thinkingMatch;

      if (embeddedThink) {
        // Extract thinking content and remaining text
        const thinkText = embeddedThink[1].trim();
        const remainingText = contentText
          .replace(/<think>[\s\S]*?<\/think>/, '')
          .replace(/<thinking>[\s\S]*?<\/thinking>/, '')
          .trim();

        if (thinkText && !reasoningText.includes(thinkText)) {
          candidate.content.parts.push({ text: thinkText, thought: true });
        }
        if (remainingText) {
          candidate.content.parts.push({ text: remainingText });
        }
      } else if (!delta?.reasoning_content?.trim() || !reasoningText.includes(contentText)) {
        // Only add content as normal text if it's not already in reasoning
        candidate.content.parts.push({ text: contentText });
      }
    }

    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        if (tc.function?.name) {
          candidate.content.parts.push({
            functionCall: {
              name: tc.function.name,
              args: JSON.parse(tc.function.arguments || '{}')
            }
          });
        }
      }
    }

    const finishReason = chunk.choices?.[0]?.finish_reason;
    if (finishReason === 'stop') candidate.finishReason = 'STOP';
    else if (finishReason === 'length') candidate.finishReason = 'MAX_TOKENS';

    return {
      candidates: [candidate],
      usageMetadata: chunk.usage ? {
        promptTokenCount: chunk.usage.prompt_tokens,
        candidatesTokenCount: chunk.usage.completion_tokens,
        totalTokenCount: chunk.usage.total_tokens
      } : undefined
    };
  }
}

module.exports = GeminiConverter;
