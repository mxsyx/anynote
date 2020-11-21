import { Remote } from 'electron'
import { Handlers } from './service/types'

declare global {
  interface Anynote {
    remote: Remote,
    handlers: Handlers
  }
}
