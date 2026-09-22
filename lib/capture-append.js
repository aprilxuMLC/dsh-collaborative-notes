// dsh-collab-notes — Notes behavior capture block append（纯逻辑，browser-safe）
//
// 把一条序列化好的 Notes behavior source-aware block 追加到当前 lane body，作为独立
// item 段落。**保留原 text 的所有字符**（含首尾空白/换行——Notes 文件是精确
// 文本状态，不得 trim）；仅做安全分隔：原文非空时以 "\n\n" 连接（block 前后
// 不吞任何既有空白）。返回新 lane body。

export function appendCaptureBlock(text, block) {
  const t = text ?? "";
  const b = block ?? "";
  return t ? t + "\n\n" + b : b;
}
