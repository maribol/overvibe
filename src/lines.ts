// Reading JSONL files that keep growing (Claude transcripts, Codex rollouts) [T1112-112]. They run to hundreds of MB,
// and every reader wants a few kinds of line out of them (the owner's messages, token counts, titles); tool calls and
// their output are most of the bytes. Each line is handed over as a view into one reused read buffer, so a line the
// reader skips never becomes a string. Decoding whole 8 MB chunks into strings and splitting them made the server's
// memory peak above 1 GB on the startup sweep, and the allocator kept most of it.
import { readSync } from 'node:fs'

const NL = 10

/**
 * Calls `line` with each whole line of `fd` from byte `from` up to `to` (empty lines are skipped). The Buffer is a
 * view that is only valid during the call: `.toString()` what you keep. `chunk`, if given, gets the whole lines of
 * each read at once (for stamp.ts lastStampIn). A partial last line is left for the next read. Returns the offset just past
 * the last whole line, or past the line where `line` returned false (reading stops there).
 */
export function eachLine(
  fd: number,
  from: number,
  to: number,
  line: (l: Buffer) => boolean | void,
  o: { chunk?: (whole: Buffer) => void; size?: number } = {},
): number {
  if (to <= from) return from
  let buf = Buffer.allocUnsafe(Math.min(o.size ?? 1 << 20, to - from))
  let have = 0 // bytes of a partial line kept at the start of buf
  let base = from // file offset of buf[0]
  let off = from // file offset of the next read
  while (off < to) {
    if (have === buf.length) {
      // one line longer than the buffer (a pasted image): grow it
      const b = Buffer.allocUnsafe(Math.min(buf.length * 2, Math.max(buf.length, to - base)))
      buf.copy(b, 0, 0, have)
      buf = b
    }
    const n = readSync(fd, buf, have, Math.min(buf.length - have, to - off), off)
    if (n <= 0) break
    off += n
    const end = have + n
    let s = 0
    for (let i = buf.indexOf(NL, have); i !== -1 && i < end; i = buf.indexOf(NL, s)) {
      if (i > s && line(buf.subarray(s, i)) === false) return base + i + 1
      s = i + 1
    }
    if (s > 0 && o.chunk) o.chunk(buf.subarray(0, s))
    buf.copy(buf, 0, s, end)
    have = end - s
    base += s
  }
  return base
}

/** `needle` as bytes, for `line.includes(...)` on a Buffer without encoding it on every call */
export const B = (needle: string) => Buffer.from(needle)
