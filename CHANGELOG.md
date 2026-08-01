# Changelog

## v2026.07.28

- 首次发布机制参考实现。
- 状态机改为通道无关的 artifact/notify 契约，并参数化状态、数据和日志目录。
- 心跳缺席检测改为 stdout 默认输出与可插拔通知钩子。
- observations/manifest 增加显式 schema 版本判断，v2 缺字段不再自动获得 legacy 豁免。
- 五平台路径改写为公开组件、验收条件和失败降级，不包含访问限制规避内容。
- 增加隔离测试、合成 fixture、MIT License 与成熟度披露。
- 治理状态：内部实施后审（post）尚未完成。
