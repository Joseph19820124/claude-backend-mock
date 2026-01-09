require('dotenv').config();
const express = require('express');
const https = require('https');

const app = express();
app.use(express.json({ limit: '50mb' }));

// Configuration
const PORT = process.env.PORT || 3456;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MOCK_API_KEY = process.env.MOCK_API_KEY; // 不设置则跳过验证

// OpenRouter model to use (always Sonnet 3.5)
const TARGET_MODEL = 'anthropic/claude-3.5-sonnet';

// Middleware: Validate API key (跳过验证如果未设置 MOCK_API_KEY)
function validateApiKey(req, res, next) {
  // 如果没有设置 MOCK_API_KEY，跳过验证
  if (!MOCK_API_KEY) {
    return next();
  }

  const authHeader = req.headers['x-api-key'] || req.headers['authorization'];
  const apiKey = authHeader?.replace('Bearer ', '');

  if (!apiKey || apiKey !== MOCK_API_KEY) {
    return res.status(401).json({
      type: 'error',
      error: {
        type: 'authentication_error',
        message: 'Invalid API key'
      }
    });
  }
  next();
}

// Middleware: Log requests
function logRequest(req, res, next) {
  const originalModel = req.body?.model || 'unknown';
  const requestId = `req_${Date.now()}`;
  req.requestId = requestId;

  console.log('\n' + '='.repeat(80));
  console.log(`[${new Date().toISOString()}] REQUEST ${requestId}`);
  console.log('='.repeat(80));
  console.log(`Method: ${req.method} ${req.path}`);
  console.log(`Original model: ${originalModel} -> Target: ${TARGET_MODEL}`);

  // Log incoming request body (truncate long content)
  const bodyToLog = JSON.parse(JSON.stringify(req.body));
  if (bodyToLog.system && typeof bodyToLog.system === 'string' && bodyToLog.system.length > 500) {
    bodyToLog.system = bodyToLog.system.substring(0, 500) + '... [TRUNCATED]';
  }
  if (bodyToLog.messages) {
    bodyToLog.messages = bodyToLog.messages.map(msg => {
      const m = { ...msg };
      if (typeof m.content === 'string' && m.content.length > 500) {
        m.content = m.content.substring(0, 500) + '... [TRUNCATED]';
      }
      return m;
    });
  }
  console.log('\n📥 INCOMING REQUEST (from Claude Code):');
  console.log(JSON.stringify(bodyToLog, null, 2));

  next();
}

// Transform Anthropic messages to OpenAI format
function transformToOpenAI(anthropicRequest) {
  const messages = [];
  
  // Handle system prompt
  if (anthropicRequest.system) {
    // System can be a string or array of content blocks
    if (typeof anthropicRequest.system === 'string') {
      messages.push({ role: 'system', content: anthropicRequest.system });
    } else if (Array.isArray(anthropicRequest.system)) {
      const systemText = anthropicRequest.system
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n');
      messages.push({ role: 'system', content: systemText });
    }
  }
  
  // Transform messages
  for (const msg of anthropicRequest.messages || []) {
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    
    // Handle content which can be string or array
    if (typeof msg.content === 'string') {
      messages.push({ role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      // Convert content blocks to OpenAI format
      const parts = [];
      for (const block of msg.content) {
        if (block.type === 'text') {
          parts.push({ type: 'text', text: block.text });
        } else if (block.type === 'image') {
          // Handle image blocks
          parts.push({
            type: 'image_url',
            image_url: {
              url: block.source?.data 
                ? `data:${block.source.media_type};base64,${block.source.data}`
                : block.source?.url
            }
          });
        } else if (block.type === 'tool_use') {
          // Tool use blocks in assistant messages
          parts.push({
            type: 'text',
            text: `[Tool Call: ${block.name}]\n${JSON.stringify(block.input, null, 2)}`
          });
        } else if (block.type === 'tool_result') {
          // Tool results in user messages
          const resultContent = typeof block.content === 'string' 
            ? block.content 
            : JSON.stringify(block.content);
          parts.push({
            type: 'text',
            text: `[Tool Result for ${block.tool_use_id}]\n${resultContent}`
          });
        }
      }
      
      // If all parts are text, simplify to string
      if (parts.length === 1 && parts[0].type === 'text') {
        messages.push({ role, content: parts[0].text });
      } else if (parts.every(p => p.type === 'text')) {
        messages.push({ role, content: parts.map(p => p.text).join('\n') });
      } else {
        messages.push({ role, content: parts });
      }
    }
  }
  
  return {
    model: TARGET_MODEL,
    messages,
    max_tokens: anthropicRequest.max_tokens || 8192,
    temperature: anthropicRequest.temperature ?? 1,
    top_p: anthropicRequest.top_p,
    stream: anthropicRequest.stream || false,
    // Add tools if present
    ...(anthropicRequest.tools && {
      tools: anthropicRequest.tools.map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema
        }
      }))
    })
  };
}

// Transform OpenAI response to Anthropic format
function transformToAnthropic(openaiResponse) {
  const choice = openaiResponse.choices?.[0];
  const message = choice?.message;

  const content = [];

  // Handle text content
  if (message?.content) {
    content.push({ type: 'text', text: message.content });
  }

  // Handle tool calls
  if (message?.tool_calls) {
    for (const toolCall of message.tool_calls) {
      content.push({
        type: 'tool_use',
        id: toolCall.id,
        name: toolCall.function.name,
        input: JSON.parse(toolCall.function.arguments || '{}')
      });
    }
  }

  return {
    id: openaiResponse.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: TARGET_MODEL, // Always return the actual model being used
    content: content.length > 0 ? content : [{ type: 'text', text: '' }],
    stop_reason: choice?.finish_reason === 'stop' ? 'end_turn'
      : choice?.finish_reason === 'tool_calls' ? 'tool_use'
      : choice?.finish_reason === 'length' ? 'max_tokens'
      : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: openaiResponse.usage?.prompt_tokens || 0,
      output_tokens: openaiResponse.usage?.completion_tokens || 0
    }
  };
}

// Handle streaming response
function handleStreamingResponse(req, res, openaiRequest) {
  const postData = JSON.stringify(openaiRequest);
  
  const options = {
    hostname: 'openrouter.ai',
    port: 443,
    path: '/api/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://claude-code-mock.local',
      'X-Title': 'Claude Code Mock API',
      'Content-Length': Buffer.byteLength(postData)
    }
  };
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  // Send initial message_start event
  const messageId = `msg_${Date.now()}`;
  const messageStartEvent = {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model: TARGET_MODEL, // Always return the actual model being used
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    }
  };
  console.log('\n📨 STREAM START (to Claude Code):');
  console.log(JSON.stringify(messageStartEvent, null, 2));
  res.write(`event: message_start\ndata: ${JSON.stringify(messageStartEvent)}\n\n`);
  
  // Send content_block_start
  res.write(`event: content_block_start\ndata: ${JSON.stringify({
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' }
  })}\n\n`);
  
  const proxyReq = https.request(options, (proxyRes) => {
    let buffer = '';
    let totalOutputTokens = 0;
    
    proxyRes.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') {
            // Send content_block_stop
            res.write(`event: content_block_stop\ndata: ${JSON.stringify({
              type: 'content_block_stop',
              index: 0
            })}\n\n`);

            // Send message_delta with stop_reason
            const messageDelta = {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn', stop_sequence: null },
              usage: { output_tokens: totalOutputTokens }
            };
            res.write(`event: message_delta\ndata: ${JSON.stringify(messageDelta)}\n\n`);

            // Send message_stop
            res.write(`event: message_stop\ndata: ${JSON.stringify({
              type: 'message_stop'
            })}\n\n`);

            console.log('\n📨 STREAM END (to Claude Code):');
            console.log(`  Total output tokens: ${totalOutputTokens}`);
            console.log(`  Model returned: ${TARGET_MODEL}`);
            console.log('='.repeat(80) + '\n');

            res.end();
            return;
          }
          
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;
            
            if (delta?.content) {
              totalOutputTokens += 1; // Approximate token count
              res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: delta.content }
              })}\n\n`);
            }
          } catch (e) {
            // Ignore parse errors for incomplete chunks
          }
        }
      }
    });
    
    proxyRes.on('end', () => {
      if (!res.writableEnded) {
        res.end();
      }
    });
    
    proxyRes.on('error', (err) => {
      console.error('Proxy response error:', err);
      res.end();
    });
  });
  
  proxyReq.on('error', (err) => {
    console.error('Proxy request error:', err);
    res.write(`event: error\ndata: ${JSON.stringify({
      type: 'error',
      error: { type: 'api_error', message: err.message }
    })}\n\n`);
    res.end();
  });
  
  proxyReq.write(postData);
  proxyReq.end();
}

// Handle non-streaming response
async function handleNonStreamingResponse(req, res, openaiRequest) {
  const postData = JSON.stringify(openaiRequest);
  
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'openrouter.ai',
      port: 443,
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://claude-code-mock.local',
        'X-Title': 'Claude Code Mock API',
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    
    const proxyReq = https.request(options, (proxyRes) => {
      let data = '';
      
      proxyRes.on('data', (chunk) => {
        data += chunk;
      });
      
      proxyRes.on('end', () => {
        try {
          const openaiResponse = JSON.parse(data);
          
          if (openaiResponse.error) {
            console.log('\n❌ OPENROUTER ERROR:');
            console.log(JSON.stringify(openaiResponse.error, null, 2));
            res.status(proxyRes.statusCode || 500).json({
              type: 'error',
              error: {
                type: 'api_error',
                message: openaiResponse.error.message || 'OpenRouter API error'
              }
            });
          } else {
            const anthropicResponse = transformToAnthropic(openaiResponse);
            console.log('\n📨 RESPONSE TO CLAUDE CODE (non-stream):');
            console.log(JSON.stringify(anthropicResponse, null, 2));
            console.log('='.repeat(80) + '\n');
            res.json(anthropicResponse);
          }
          resolve();
        } catch (err) {
          console.error('Response parse error:', err, data);
          res.status(500).json({
            type: 'error',
            error: { type: 'api_error', message: 'Failed to parse response' }
          });
          reject(err);
        }
      });
    });
    
    proxyReq.on('error', (err) => {
      console.error('Proxy request error:', err);
      res.status(500).json({
        type: 'error',
        error: { type: 'api_error', message: err.message }
      });
      reject(err);
    });
    
    proxyReq.write(postData);
    proxyReq.end();
  });
}

// Main messages endpoint
app.post('/v1/messages', validateApiKey, logRequest, async (req, res) => {
  try {
    const openaiRequest = transformToOpenAI(req.body);

    console.log(`\n📤 OUTGOING REQUEST (to OpenRouter):`);
    console.log(`  Model: ${openaiRequest.model}`);
    console.log(`  Stream: ${openaiRequest.stream}`);
    console.log(`  Messages count: ${openaiRequest.messages.length}`);
    console.log(`  Max tokens: ${openaiRequest.max_tokens}`);

    if (openaiRequest.stream) {
      handleStreamingResponse(req, res, openaiRequest);
    } else {
      await handleNonStreamingResponse(req, res, openaiRequest);
    }
  } catch (err) {
    console.error('Error processing request:', err);
    res.status(500).json({
      type: 'error',
      error: { type: 'api_error', message: err.message }
    });
  }
});

// Count tokens endpoint (mock implementation)
app.post('/v1/messages/count_tokens', validateApiKey, (req, res) => {
  // Simple approximation: ~4 characters per token
  let totalChars = 0;
  
  if (req.body.system) {
    totalChars += typeof req.body.system === 'string' 
      ? req.body.system.length 
      : JSON.stringify(req.body.system).length;
  }
  
  for (const msg of req.body.messages || []) {
    if (typeof msg.content === 'string') {
      totalChars += msg.content.length;
    } else {
      totalChars += JSON.stringify(msg.content).length;
    }
  }
  
  res.json({ input_tokens: Math.ceil(totalChars / 4) });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', target_model: TARGET_MODEL });
});

// Models endpoint (for compatibility)
app.get('/v1/models', validateApiKey, (req, res) => {
  res.json({
    data: [
      { id: 'claude-opus-4-5-20250514', object: 'model' },
      { id: 'claude-sonnet-4-20250514', object: 'model' },
      { id: 'claude-3-5-sonnet-20241022', object: 'model' },
      { id: 'claude-3-5-haiku-20241022', object: 'model' }
    ]
  });
});

// Start server
app.listen(PORT, () => {
  console.log('='.repeat(50));
  console.log('Claude Code Mock API Server');
  console.log('='.repeat(50));
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Target model: ${TARGET_MODEL}`);
  console.log(`API Key validation: ${MOCK_API_KEY ? 'enabled' : 'disabled'}`);
  console.log('');
  console.log('Configure Claude Code with:');
  console.log(`  ANTHROPIC_BASE_URL=http://localhost:${PORT}`);
  if (MOCK_API_KEY) {
    console.log(`  ANTHROPIC_API_KEY=${MOCK_API_KEY}`);
  } else {
    console.log(`  ANTHROPIC_API_KEY=any-value-works`);
  }
  console.log('='.repeat(50));
});
