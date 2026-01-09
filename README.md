# Claude Code Mock API

一个API代理服务，让Claude Code通过OpenRouter调用模型。

## 工作原理

```
Claude Code  -->  Mock API  -->  OpenRouter (Sonnet 3.5)
  (opus4.5)       (转换)          (实际调用)
```

- Claude Code 发送请求时使用任意模型名称（如 `claude-opus-4-5-20250514`）
- Mock API 接收请求后，**始终**转发到 OpenRouter 的 Sonnet 3.5
- 返回结果显示用户选择的模型名称

## 快速开始

### 1. 安装依赖

```bash
cd /Users/chenjian/Documents/Claude-backend-mock
npm install
```

### 2. 配置环境变量

编辑 `.env` 文件，填入你的 OpenRouter API Key：

```bash
OPENROUTER_API_KEY=sk-or-v1-你的openrouter密钥
MOCK_API_KEY=sk-mock-api-key-12345
PORT=3456
```

获取 OpenRouter API Key: https://openrouter.ai/keys

### 3. 启动服务

```bash
npm start
```

或开发模式（自动重载）：

```bash
npm run dev
```

### 4. 配置 Claude Code

设置环境变量后启动 Claude Code：

```bash
export ANTHROPIC_BASE_URL=http://localhost:3456
export ANTHROPIC_API_KEY=sk-mock-api-key-12345
claude
```

或者在 `~/.claude/settings.json` 中配置：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:3456",
    "ANTHROPIC_API_KEY": "sk-mock-api-key-12345"
  }
}
```

## API 端点

| 端点 | 说明 |
|------|------|
| `POST /v1/messages` | 主要的消息接口（支持流式） |
| `POST /v1/messages/count_tokens` | Token 计数 |
| `GET /v1/models` | 模型列表 |
| `GET /health` | 健康检查 |

## 修改目标模型

编辑 `server.js` 中的 `TARGET_MODEL` 常量：

```javascript
// 当前配置：Sonnet 3.5
const TARGET_MODEL = 'anthropic/claude-3.5-sonnet';

// 可改为其他模型，例如：
// const TARGET_MODEL = 'anthropic/claude-3-opus';
// const TARGET_MODEL = 'openai/gpt-4-turbo';
```

## 日志示例

```
[2024-01-09T10:30:00.000Z] POST /v1/messages
  Original model: claude-opus-4-5-20250514 -> Target: anthropic/claude-3.5-sonnet
  Stream: true
  Messages count: 5
```

## 注意事项

1. 确保 OpenRouter 账户有足够余额
2. 流式响应已完整支持
3. 工具调用（Tool Use）已基本支持
4. 图片输入已支持转换
