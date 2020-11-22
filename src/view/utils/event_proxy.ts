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

/* eslint-disable @typescript-eslint/ban-types */

type EventNames = 'Folder-Create'

class EventProxy {
  private events: {
    [index: string]: Function[] | null
  }

  constructor() {
    this.events = {}
  }

  on(name: EventNames, fn: Function): void {
    if (!Array.isArray(this.events[name])) {
      this.events[name] = []
    }

    const fns = this.events[name] as Function[]
    if (typeof fn === "function" && !fns.includes(fn)) {
      fns.push(fn)
    }
  }

  trigger(name: EventNames): void {
    const fns = this.events[name] || []
    for (const fn of fns) {
      fn(name)
    }
  }

  remove(name: EventNames, fn: Function) {
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
