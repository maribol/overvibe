// v-tip [T1112-126]: a hover tooltip that shows at once (a native title waits about a second and holds plain text
// only). The value is a title, optional rows (a line, or a label and a number lined up right) and a foot line,
// or a function that returns one (a promise too, for numbers fetched on hover). Built with textContent only:
// task lines come from files. One tip at a time; a tip on a child wins, and its parent's comes back on leaving it.
import type { Directive } from 'vue'

export type TipRow = string | [string, string | number]
export type TipBody = { title: string; rows?: TipRow[]; foot?: string }
export type TipValue = TipBody | string | null | (() => TipBody | string | null | Promise<TipBody | string | null>)

type El = HTMLElement & { _tip?: TipValue }
const DELAY_MS = 120
let box: HTMLDivElement | null = null
let owner: El | null = null
let timer: ReturnType<typeof setTimeout> | undefined
let seq = 0

function render(b: TipBody) {
  box ??= Object.assign(document.createElement('div'), { className: 'dialog vtip' })
  box.setAttribute('role', 'tooltip')
  box.replaceChildren()
  const add = (cls: string, text: string, parent: HTMLElement = box!) => {
    const d = document.createElement('div')
    d.className = cls
    d.textContent = text
    parent.append(d)
    return d
  }
  add('vtip-title', b.title)
  for (const r of b.rows ?? []) {
    if (typeof r === 'string') add('vtip-line', r)
    else {
      const row = add('vtip-row', '')
      add('vtip-label', r[0], row)
      add('vtip-num', typeof r[1] === 'number' ? r[1].toLocaleString('en-US') : r[1], row)
    }
  }
  if (b.foot) add('vtip-foot', b.foot)
  if (!box.isConnected) document.body.append(box)
}

// above the element, left edges lined up; below when there is no room; always inside the window
function place(el: HTMLElement) {
  if (!box) return
  const r = el.getBoundingClientRect()
  const w = box.offsetWidth
  const h = box.offsetHeight
  const x = Math.max(8, Math.min(r.left, innerWidth - w - 8))
  const y = r.top - h - 6 >= 8 ? r.top - h - 6 : Math.min(r.bottom + 6, innerHeight - h - 8)
  box.style.left = `${x}px`
  box.style.top = `${y}px`
}

export function hideTip() {
  clearTimeout(timer)
  seq++
  owner = null
  box?.remove()
}

async function show(el: El) {
  const n = ++seq
  let v = el._tip
  if (typeof v === 'function') v = await v()
  if (n !== seq || !el.isConnected) return
  if (!v) return hideTip()
  owner = el
  render(typeof v === 'string' ? { title: v } : v)
  place(el)
}

function enter(e: PointerEvent) {
  const el = e.currentTarget as El
  // the innermost element with a tip wins: a parent's enter comes first, its child's replaces it
  if (owner && owner !== el && el.contains(owner)) return
  clearTimeout(timer)
  timer = setTimeout(() => void show(el), owner ? 0 : DELAY_MS)
}

function leave(e: PointerEvent) {
  const el = e.currentTarget as El
  const to = (e.relatedTarget as HTMLElement | null)?.closest?.('[data-vtip]') as El | null
  if (to && to !== el && (to.contains(el) || el.contains(to))) {
    clearTimeout(timer)
    timer = setTimeout(() => void show(to), 0)
    return
  }
  hideTip()
}

export const vTip: Directive<El, TipValue> = {
  mounted(el, b) {
    el._tip = b.value
    el.dataset.vtip = ''
    el.addEventListener('pointerenter', enter)
    el.addEventListener('pointerleave', leave)
    el.addEventListener('pointerdown', hideTip)
  },
  updated(el, b) {
    el._tip = b.value
    if (owner === el && typeof b.value !== 'function') void show(el)
  },
  beforeUnmount(el) {
    if (owner === el) hideTip()
    el.removeEventListener('pointerenter', enter)
    el.removeEventListener('pointerleave', leave)
    el.removeEventListener('pointerdown', hideTip)
  },
}

addEventListener('scroll', hideTip, true)
addEventListener('blur', hideTip)
