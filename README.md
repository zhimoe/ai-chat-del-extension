# AI 会话批量管理 Chrome 扩展

这个扩展会在 ChatGPT 和 Gemini 左侧历史会话列表里加入复选框和批量操作条，用于多选并批量删除会话。

支持的网站：

- `https://chatgpt.com/`
- `https://gemini.google.com/app`

## 安装

1. 打开 Chrome 的 `chrome://extensions/`。
2. 打开右上角「开发者模式」。
3. 点击「加载已解压的扩展程序」。
4. 选择本目录。
5. 刷新 ChatGPT 或 Gemini 页面。

## 使用

- 勾选左侧历史会话前面的复选框。
- 点击「删除」。
- 在确认框中确认后，扩展会逐个删除会话。

## 说明

- ChatGPT 使用 `PATCH /backend-api/conversation/{conversation_id}`，请求体为 `{ "is_visible": false }`。
- Gemini 通过页面原生的“更多选项 → 删除 → 确认”流程逐个删除。`batchexecute` 请求中的 `at`、`f.sid`、`_reqid` 和 `bl` 都是动态值，因此扩展不会硬编码这些参数。
- Gemini 只会处理当前侧边栏已加载并可勾选的会话；继续滚动可加载更多会话。
- 如果网站后续调整接口或 DOM 结构，可能需要更新 `content.js` 中的选择器或删除流程。
- 删除失败时，页面会提示失败数量，详细错误会输出到 DevTools Console。
