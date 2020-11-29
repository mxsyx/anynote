/*
 * File: /src/view/utils/event_proxy.ts
 * Author: Mxsyx (mxsyxin@gmail.com)
 * Created At: 2020-11-22 09:19:16
 * -----
 * Last Modified: 2020-11-22 09:23:35
 * Modified By: Mxsyx (mxsyxin@gmail.com>)
 * -----
 * Lisense: GNU General Public License v3
 */
type EventNames = 'Folder-Created' | 'Folder-Before-Rename'

type Listener = (payload?: AnyObject) => unknown

class EventProxy {
  private events: {
    [index: string]: Listener[] | null
  }

  constructor() {
    this.events = {}
  }

  on(name: EventNames, fn: Listener): void {
    if (!Array.isArray(this.events[name])) {
      this.events[name] = []
    }

    const fns = this.events[name] as Listener[]
    if (typeof fn === "function" && !fns.includes(fn)) {
      fns.push(fn)
    }
  }

  trigger(name: EventNames, payload?: AnyObject): void {
    const fns = this.events[name] || []
    for (const fn of fns) {
      fn(payload)
    }
  }

  remove(name: EventNames, fn: Listener) {
    const fns = this.events[name]

    if (!Array.isArray(fns)) return

    if (typeof fn !== "function") {
      this.events[name] = null
    }

    for (let i = 0; i < fns.length; ++i) {
      if (fns[i] === fn) {
        fns.splice(i, 1)
      }
    }
  }

  clear() {
    this.events = {}
  }
}

const eventProxy = new EventProxy()

export default eventProxy
