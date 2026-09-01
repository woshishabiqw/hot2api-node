/**
 * Anthropic ↔ OpenAI 协议转换器
 */

class AnthropicConverter {
  /**
   * 检测请求体是否为 Anthropic 格式
   */
  static isAnthropicFormat(body) {
    // Anthropic 格式特征：有 system 顶层字段，或 messages 中有 content 数组（多模态）
    return body.system !== undefined ||
      (Array.isArray(body.messages) && body.messages.some(m =>
        Array.isArray(m.content) && m.content.some(c => c.type === 'text' || c.type === 'image')
      ));
  }

  /**
   * Anthropic 请求 → OpenAI 请求
   */
  static requestToOpenai(anthropicBody) {
    const messages = [];
    const openaiBody = {};

    // System 消息
    if (anthropicBody.system && anthropicBody.system !== '[undefined]') {
      if (typeof anthropicBody.system === 'string') {
        messages.push({ role: 'system', content: anthropicBody.system });
      } else if (Array.isArray(anthropicBody.system)) {
        // Anthropic system 可以是数组 [{type: "text", text: "..."}]
        const text = anthropicBody.system
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join('\n');
        if (text) messages.push({ role: 'system', content: text });
      }
    }

    // Messages
    for (const msg of (anthropicBody.messages || [])) {
      if (msg.role === 'user') {
        if (typeof msg.content === 'string') {
          messages.push({ role: 'user', content: msg.content });
        } else if (Array.isArray(msg.content)) {
          // 多模态内容
          const parts = [];
          for (const block of msg.content) {
            if (block.type === 'text') {
              parts.push({ type: 'text', text: block.text });
            } else if (block.type === 'image') {
              parts.push({
                type: 'image_url',
                image_url: {
                  url: `data:${block.source.media_type};base64,${block.source.data}`
                }
              });
            } else if (block.type === 'tool_result') {
              // Anthropic tool_result → OpenAI tool message
              let toolContent = '';
              if (typeof block.content === 'string') {
                toolContent = block.content;
              } else if (Array.isArray(block.content)) {
                toolContent = block.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
                if (!toolContent) toolContent = JSON.stringify(block.content);
              } else {
                toolContent = JSON.stringify(block.content || '');
              }
              messages.push({
                role: 'tool',
                tool_call_id: block.tool_use_id,
                content: toolContent
              });
              continue;
            }
          }
          if (parts.length > 0) {
            messages.push({ role: 'user', content: parts });
          }
        }
      } else if (msg.role === 'assistant') {
        if (typeof msg.content === 'string') {
          messages.push({ role: 'assistant', content: msg.content });
        } else if (Array.isArray(msg.content)) {
          // 可能包含 text 和 tool_use
          let text = '';
          const toolCalls = [];
          for (const block of msg.content) {
            if (block.type === 'text') {
              text += block.text;
            } else if (block.type === 'tool_use') {
              toolCalls.push({
                id: block.id,
                type: 'function',
                function: {
                  name: block.name,
                  arguments: JSON.stringify(block.input || {})
                }
              });
            }
          }
          const assistantMsg = { role: 'assistant' };
          if (text) assistantMsg.content = text;
          if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
          messages.push(assistantMsg);
        }
      }
    }

    openaiBody.model = anthropicBody.model;
    openaiBody.messages = messages;
    // Strip Anthropic-only parameters that OpenAI doesn't support
    // thinking, output_config, top_k are Anthropic-specific
    if (anthropicBody.max_tokens) openaiBody.max_tokens = anthropicBody.max_tokens;
    if (anthropicBody.temperature !== undefined) openaiBody.temperature = anthropicBody.temperature;
    if (anthropicBody.top_p !== undefined) openaiBody.top_p = anthropicBody.top_p;
    if (anthropicBody.stop_sequences) openaiBody.stop = anthropicBody.stop_sequences;
    if (anthropicBody.stream) openaiBody.stream = anthropicBody.stream;

    // Tools: Anthropic → OpenAI
    if (anthropicBody.tools && Array.isArray(anthropicBody.tools)) {
      openaiBody.tools = anthropicBody.tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description || '',
          parameters: t.input_schema || { type: 'object', properties: {} }
        }
      }));
    }

    // Tool choice: Anthropic → OpenAI
    if (anthropicBody.tool_choice) {
      if (anthropicBody.tool_choice.type === 'auto') {
        openaiBody.tool_choice = 'auto';
      } else if (anthropicBody.tool_choice.type === 'any') {
        openaiBody.tool_choice = { type: 'required' };
      } else if (anthropicBody.tool_choice.type === 'tool') {
        openaiBody.tool_choice = {
          type: 'function',
          function: { name: anthropicBody.tool_choice.name }
        };
      }
    }

    return openaiBody;
  }

  /**
   * OpenAI 响应 → Anthropic 响应 (非流式)
   */
  static responseToAnthropic(openaiResponse, model) {
    const choice = openaiResponse.choices?.[0];
    const message = choice?.message;
    const usage = openaiResponse.usage || {};

    // 构建 Anthropic content blocks
    const content = [];
    if (message?.content) {
      content.push({ type: 'text', text: message.content });
    }
    if (message?.tool_calls) {
      for (const tc of message.tool_calls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments || '{}')
        });
      }
    }

    // 映射 finish_reason
    let stopReason = 'end_turn';
    if (choice?.finish_reason === 'length') stopReason = 'max_tokens';
    else if (choice?.finish_reason === 'tool_calls') stopReason = 'tool_use';
    else if (choice?.finish_reason === 'stop') stopReason = 'end_turn';

    // 处理 reasoning_content（非流式）
    if (message?.reasoning_content) {
      content.unshift({ type: 'thinking', thinking: message.reasoning_content, signature: '' });
    }

    return {
      id: openaiResponse.id || `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      content,
      model: model,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: usage.prompt_tokens || 0,
        output_tokens: usage.completion_tokens || 0
      }
    };
  }

  /**
   * OpenAI 流式 chunk → Anthropic 流式事件列表
   * 返回数组，每个元素是一个 Anthropic SSE 事件
   */
  static streamChunkToAnthropic(chunk, state) {
    const events = [];

    if (chunk.object !== 'chat.completion.chunk') return events;

    const choice = chunk.choices?.[0];
    const delta = choice?.delta;
    const model = chunk.model;

    // 初始化：发送 message_start
    if (!state.started) {
      state.started = true;
      state.messageId = chunk.id || `msg_${Date.now()}`;
      events.push({
        type: 'message_start',
        message: {
          id: state.messageId,
          type: 'message',
          role: 'assistant',
          content: [],
          model: model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: chunk.usage?.prompt_tokens || 0, output_tokens: 0 }
        }
      });
      // 发送 content_block_start
      events.push({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' }
      });
      state.contentBlockStarted = true;
    }

    // 处理 reasoning/thinking 内容
    if (delta?.reasoning_content) {
      if (!state.thinkingBlockStarted) {
        state.thinkingBlockStarted = true;
        events.push({
          type: 'content_block_start',
          index: state.toolCalls ? Object.keys(state.toolCalls).length + 1 : 1,
          content_block: { type: 'thinking', thinking: '', signature: '' }
        });
      }
      events.push({
        type: 'content_block_delta',
        index: state.toolCalls ? Object.keys(state.toolCalls).length + 1 : 1,
        delta: { type: 'thinking_delta', thinking: delta.reasoning_content }
      });
    }

    // 处理内容
    if (delta?.content) {
      events.push({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: delta.content }
      });
    }

    // 处理 tool_calls
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        if (tc.id && !state.toolCalls?.[tc.index]) {
          // 新 tool_call 开始
          if (!state.toolCalls) state.toolCalls = {};
          state.toolCalls[tc.index] = { id: tc.id, name: tc.function?.name || '', arguments: '' };

          // 关闭之前的 text block
          if (state.contentBlockStarted && !state.textBlockClosed) {
            events.push({ type: 'content_block_stop', index: 0 });
            state.textBlockClosed = true;
          }

          // 开始新的 tool_use block
          events.push({
            type: 'content_block_start',
            index: tc.index + 1,
            content_block: { type: 'tool_use', id: tc.id, name: tc.function?.name || '' }
          });
        }
        if (tc.function?.arguments) {
          if (state.toolCalls?.[tc.index]) {
            state.toolCalls[tc.index].arguments += tc.function.arguments;
          }
          events.push({
            type: 'content_block_delta',
            index: tc.index + 1,
            delta: { type: 'input_json_delta', partial_json: tc.function.arguments }
          });
        }
      }
    }

    // 处理 finish_reason
    if (choice?.finish_reason) {
      // 关闭内容块
      if (!state.textBlockClosed && state.contentBlockStarted) {
        events.push({ type: 'content_block_stop', index: 0 });
        state.textBlockClosed = true;
      }
      // 关闭 thinking block
      if (state.thinkingBlockStarted && !state.thinkingBlockClosed) {
        const thinkingIndex = state.toolCalls ? Object.keys(state.toolCalls).length + 1 : 1;
        events.push({ type: 'content_block_stop', index: thinkingIndex });
        state.thinkingBlockClosed = true;
      }
      // 关闭 tool_use blocks
      if (state.toolCalls) {
        for (const [idx] of Object.entries(state.toolCalls)) {
          events.push({ type: 'content_block_stop', index: parseInt(idx) + 1 });
        }
      }

      let stopReason = 'end_turn';
      if (choice.finish_reason === 'length') stopReason = 'max_tokens';
      else if (choice.finish_reason === 'tool_calls') stopReason = 'tool_use';

      events.push({
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: chunk.usage?.completion_tokens || 0 }
      });
      events.push({ type: 'message_stop' });
    }

    return events;
  }
}

module.exports = AnthropicConverter;
