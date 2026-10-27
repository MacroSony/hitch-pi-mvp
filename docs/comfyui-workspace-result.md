# Comfy workspace worker result

## 接口与集成

新增 `src/comfyui/workspace.ts`，同步导出：

```ts
materializeComfyWorkspaceResult({
  userId, // 已认证 owner
  workspace, // 已验证的配置绝对路径，不来自模型
  artifact, // 当前 owner 已完成、已验证的 RuntimeArtifact
  media, // MediaStore
});
// { path: "/workspace/comfy-<artifact UUID>.<suffix>",
//   relativePath: "comfy-<artifact UUID>.<suffix>" }
```

- 仅接受现有 MediaStore 的 `artifact_<UUID>` / `<owner>/<UUID>.blob` 格式；图片 PNG/JPEG/WebP，视频 MP4，大小 `1..10*1024*1024` 字节。
- owner、类型、大小、SHA-256、source descriptor 的 uid/private/regular/single-link/只读属性均检查。重新读取实际打开的 source fd 验证，不能依赖先前 pathname 验证后再盲拷贝。
- 文件名只由 artifact UUID 和允许的 MIME 后缀决定，忽略 displayName；没有模型 destination 参数。
- 主脑稍后在 completion 与 `paint_result` 调用。此 worker 不修改 runtime/service/types，不生成、发布、发送或调用网络。
- 统一抛出 `Error("Comfy workspace result is unavailable.")`，不带原始 cause 或宿主路径。

## 文件系统约束

Linux `/proc/self/fd` 必须可用。从打开的 `/` 开始逐组件 `O_DIRECTORY|O_NOFOLLOW` 遍历并持有目录 fd，拒绝最终及祖先 symlink。所有目标 IO 都锚定 workspace dirfd；多次核对整条目录 inode 链及 fd 的当前绝对位置，检测调用期间观测到的目录改名/交换。

使用 `O_CREAT|O_EXCL|O_NOFOLLOW` 创建 private 文件；不覆盖现有 inode。已有目标只以只读 fd 打开，必须 uid 为当前服务 uid、private、regular、nlink=1，且长度、EOF、SHA-256 精确匹配。新文件分块写入前检查属性，完成后重新读取验证，再 fsync 文件/目录；返回前检查验证时的元数据快照与最终 pathname/inode 一致。非普通文件使用 nonblocking open，防止 FIFO 阻塞后再验证的问题。

## 验证证据

均在本 worktree 本地执行：

- `npm ci --offline --no-audit --no-fund`：成功，独立安装，没有链接其它 worktree node_modules。
- `npm run build`：成功。
- `npm run typecheck`：成功。
- `node --disable-warning=ExperimentalWarning --test dist/test/comfyui-workspace.test.js`：31/31 通过。
- 扩展定向测试（workspace/result/video/media）：39 个，38 通过、1 个既有 opt-in sandbox video 测试跳过。
- 新文件定向 Prettier 检查通过。

`test/comfyui-workspace.test.ts` 使用真实临时目录和内嵌 tiny 合法 PNG/JPEG/WebP/MP4；开发时另用本地 CPU ffmpeg 解码检查四个内嵌 fixture 均成功，定向单测本身不启动媒体工具。覆盖 owner、大小边界、损坏/截断/可写 source、source/target symlink/hardlink、相同长度不同 hash 冲突、不可覆盖、幂等 inode/mode/mtime、workspace/祖先 symlink，以及 IO 边界注入的改名、交换、晚期内容篡改/换 inode/硬链接。初轮测试的 atime 断言已修正：验证读取可能合法更新 atime，但不得更改写入相关元数据或内容。

## 残余风险 / 主脑注意

- 此接口依赖可信调用方提供 owner-scoped completed result；它不能自行证明 job 状态或数据库 provenance。MP4 必须已通过现有 `inspectGeneratedVideo`，图片沿用 MediaStore 验证；这里不是完整媒体解码器，只额外检查 signature。
- 配置 root 的起始身份由调用方验证；本接口没有配置发布时的 expected inode 参数。它检查调用期间持有的 inode 链，不替代配置/挂载身份管理。
- workspace 对模型仍然可写。最后一次检查之后的修改、瞬时移走又恢复，以及进程外恶意并发不能被普通文件系统操作完全排除；不承诺返回路径永久不变或穷尽竞态认证。任何后续发送必须继续走现有 immutable publication snapshot，不能直接发送 live workspace 文件。
- 写入失败或检测到竞争后，不尝试 unlink 路径，避免删除攻击者替换的文件；可能留下部分/已完成的新文件，后续只有精确合法匹配才复用，否则保持拒绝，需要可信清理。
- 同步操作有最多 10 MiB 的读取/复制/fsync 开销；没有额外配额策略。仍需主脑集成评审；未作独立子代理评审、完整测试套件、真实 sandbox/channel/provider/GPU 或线上验收。
