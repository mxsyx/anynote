/* eslint-disable @typescript-eslint/no-explicit-any */

declare const anynote: Anynote

declare module "*.css" {
  const content: any
  export default content
}
declare module "*.jpg" {
  const content: any
  export default content
}

type AnyObject<K extends string | number | symbol = string, V = any> = Record<K, V>
