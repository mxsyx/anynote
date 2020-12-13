/*
 * File: /src/view/layout/Panel.tsx
 * Author: Mxsyx (mxsyxin@gmail.com)
 * Created At: 2020-11-29 10:08:47
 * -----
 * Last Modified: 2020-11-29 10:09:23
 * Modified By: Mxsyx (mxsyxin@gmail.com>)
 * -----
 * Lisense: GNU General Public License v3
 */
import React, { FC } from "react"

interface Props {
  index: number
  value: number
}

const Panel: FC<Props> = props => {
  const { value, index, children } = props

  return (
    <div role="tabpanel" hidden={value !== index} id={`vertical-tabpanel-${index}`}>
      {value === index && children}
    </div>
  )
}

export default Panel
