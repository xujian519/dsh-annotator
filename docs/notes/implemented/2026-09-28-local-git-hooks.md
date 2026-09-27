# Note: 加本地 git 钩子（本地窄、CI 全）

Status: implemented

## Problem

此前提交前后没有任何本地检查：`pnpm run check` 全靠自觉，格式化与空白问题要到 CI 才会暴露。规范要求「本地窄 / CI 全」——钩子只做秒级的事，全量留给 CI，否则每次提交都卡住，而卡住的门禁会被绕过。

## Decision

用 lefthook（`lefthook.yml`）：

- **pre-commit**（并行）：对暂存文件跑 `oxlint --type-aware --deny-warnings --fix` 并重新暂存（`stage_fixed`）；再跑 `git diff --cached --check` 查空白。
- **pre-push**：只跑 `pnpm run typecheck`。
- 钩子里**不跑**测试，更不跑 coverage。
- `lefthook.yml` 的 `exclude` 排除 `tests/gates/fixtures/**`：那三份文件本来就是故意写坏用来证明 lint 会红的，让它们参与提交前检查只会让每次改动 fixture 都失败。
- `package.json` 加 `"prepare": "lefthook install"`，新克隆跑一次 `pnpm install` 就装好钩子。
- `pnpm-workspace.yaml` 的 `allowBuilds` 放行 `lefthook`，否则它的 postinstall 拿不到二进制。

## Alternatives considered

- **husky + lint-staged** —— 落选。要另加两个依赖和一次 `husky init` 步骤；lefthook 一个二进制同时覆盖 pre-commit / pre-push，配置即文件。
- **pre-commit 里也跑 `pnpm run check`** —— 落选。全量 check 约数秒，每次都跑会让提交变慢，而慢门禁会被 `--no-verify` 绕过；这与「本地窄、CI 全」直接冲突。
- **pre-push 加跑测试** —— 落选。测试仍属于「全」，push 频繁时会明显变慢；CI 已经覆盖。
- **不加钩子，只在 CI 拦** —— 落选。反馈来得太晚（要等一次 push + CI 往返），而暂存文件级 lint 是秒级的。

## Consequences

**换来**：明显的低级问题在提交那一刻就被拦下并自动修复；push 前保证类型干净；全量检查仍由 CI 一条 job 负责。

**付出**：`pnpm install` 现在会写 `.git/hooks`（`prepare` 脚本）；`oxlint --fix` 可能改动暂存内容，因此配了 `stage_fixed` 把它重新暂存，不会留下「改了但没暂存」的错位。

**验证**：`lefthook validate` 通过，`lefthook install` 生成 `pre-commit` / `pre-push` 桩；本轮全部改动都在钩子生效前完成，钩子的实际拦截行为留待首次提交时观察。
