// A folder path cut from the middle so it fits [T1112-124]: the start ("~/Work") and the last folder stay,
// the folders between them turn into "…" one at a time, left to right. `fits` says whether a text fits.
export function midPath(path: string, fits: (s: string) => boolean): string {
  if (fits(path)) return path
  const segs = path.split('/')
  const last = segs.length - 1
  if (last < 2) return endCut(path, fits)
  // the head: "~/Work" (two parts) when the path starts with ~ or is absolute, else the first folder
  const headN = segs[0] === '~' || segs[0] === '' ? Math.min(2, last - 1) : 1
  for (let h = headN; h >= 1; h--)
    for (let from = h + 1; from <= last; from++) {
      const s = [...segs.slice(0, h), '…', ...segs.slice(from)].join('/')
      if (fits(s)) return s
    }
  // even "~/…/name" is too long: cut the name from its middle
  const lead = (segs[0] === '' ? '' : segs[0] + '/') + '…/'
  return endCut(segs[last]!, (s) => fits(lead + s), lead)
}

/** a single name cut in its middle ("very-lo…-name"), keeping more of the end */
function endCut(name: string, fits: (s: string) => boolean, lead = ''): string {
  for (let keep = name.length - 1; keep >= 2; keep--) {
    const front = Math.floor(keep / 2), back = keep - front
    const s = name.slice(0, front) + '…' + name.slice(name.length - back)
    if (fits(s)) return lead + s
  }
  return lead + '…' + name.slice(-1)
}
