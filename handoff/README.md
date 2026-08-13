# VibeMate Handoff

本目录用于存放开发过程中的临时交接资料，包括需求摘要、设计决策、调研结论、
待验证事项和阶段性实施说明。

这里的内容用于帮助后续开发快速恢复上下文，不替代正式文档：

- 正式产品需求：`docs/product-requirements.md`
- 正式实施计划：`docs/implementation-plan.md`

## 当前文档

- `current-context.md`：当前需求、范围和产品原则
- `transport-architecture.md`：同机与远程场景的传输架构
- `reference-projects.md`：Clawd on Desk 与 Happy 的调研结论
- `open-questions.md`：进入实现前仍需验证和确定的问题

## 使用约定

- 只记录当前阶段确实有助于交接的内容。
- 已稳定的需求和决策应迁移到 `docs/` 下的正式文档。
- 内容失效后应更新或删除，避免临时结论被误认为正式规范。
- 不在此目录保存密钥、令牌、原始 Hook 敏感载荷或用户数据。
