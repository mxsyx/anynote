// @ts-ignore
import { actions } from './service'
import Electron from 'electron'

declare global {
  interface Anynote {
    actions: typeof actions,
    remote: Electron.Remote
  }
}
