// 向量工具：float32 BLOB 编解码、余弦、归一化。
//
// **关键陷阱**：SQLite 返回的 BLOB 不保证 4 字节对齐——`node:sqlite` 给回的
// Uint8Array 可能带非 0 的 byteOffset，此时 `new Float32Array(buf.buffer, buf.byteOffset, n)`
// 会抛 RangeError。decodeVec() 内部处理了这个分支。
//
// 字节序：直接用平台字节序（x86 / ARM64 均为小端）。同一台机器读写自洽；
// 跨架构迁移备份时需另行转换——当前设计不涉及。

/** 记忆向量维度（bge-small-zh-v1.5 输出 512 维）。 */
export const VEC_DIM = 512

/** 单个向量的字节数。 */
export const VEC_BYTES = VEC_DIM * 4

/** 检查 BLOB 长度是否与维度自洽。 */
export function isValidVecBlob(buf: Uint8Array, dim = VEC_DIM): boolean {
  return buf.byteLength === dim * 4
}

/**
 * 把（通常已归一化的）向量编码成 BLOB。
 *
 * 走 TypedArray 视图而非逐字节写入——省掉 length 次函数调用。
 */
export function encodeVec(v: Float32Array): Uint8Array {
  const out = new Uint8Array(v.length * 4)
  new Float32Array(out.buffer, out.byteOffset, v.length).set(v)
  return out
}

/**
 * 解码 BLOB 为 Float32Array **视图**（与入参共享内存，只读使用）。
 *
 * 入参 byteOffset 非 4 的倍数时先复制一份再建视图——这是 SQLite BLOB 的常见情形。
 */
export function decodeVec(buf: Uint8Array): Float32Array {
  if (buf.byteLength % 4 !== 0) {
    throw new Error(`向量 BLOB 长度 ${buf.byteLength} 不是 4 的倍数`)
  }
  const aligned: Uint8Array = buf.byteOffset % 4 === 0 ? buf : new Uint8Array(buf)
  return new Float32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 4)
}

/** 解码为**独立副本**——需要原地修改（如增量更新 sum_vec）时用这个。 */
export function decodeVecCopy(buf: Uint8Array): Float32Array {
  return new Float32Array(decodeVec(buf))
}

/** 点积。两个向量都已 L2 归一化时，它就是余弦相似度。 */
export function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length)
  let s = 0
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!
  return s
}

/** L2 范数。 */
export function l2norm(v: Float32Array): number {
  let s = 0
  for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!
  return Math.sqrt(s)
}

/** 原地归一化；零向量原样返回（encoder 降级时用零向量占位）。 */
export function normalizeInPlace(v: Float32Array): Float32Array {
  const n = l2norm(v)
  if (n > 0) for (let i = 0; i < v.length; i++) v[i] = v[i]! / n
  return v
}

/** 归一化到新数组。 */
export function normalized(v: Float32Array): Float32Array {
  return normalizeInPlace(new Float32Array(v))
}

/** 余弦相似度（对未归一化向量也正确；任一为零向量时返回 0）。 */
export function cosine(a: Float32Array, b: Float32Array): number {
  const na = l2norm(a)
  const nb = l2norm(b)
  if (na === 0 || nb === 0) return 0
  return dot(a, b) / (na * nb)
}

/** 零向量——encoder 降级时写入的占位值。 */
export function zeroVec(dim = VEC_DIM): Float32Array {
  return new Float32Array(dim)
}

/** 是否为零向量（据此判断该 atom 从未被成功编码）。 */
export function isZeroVec(v: Float32Array): boolean {
  for (let i = 0; i < v.length; i++) if (v[i] !== 0) return false
  return true
}