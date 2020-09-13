import React, { FC } from "react"
import { TreeView, TreeItem, TreeItemProps } from "@material-ui/lab"
import { Typography } from "@material-ui/core"
import {
  ArrowDropDown,
  ArrowRight,
} from "@material-ui/icons"

import popupMenu from 'utils/menu'
import styles from './index.css'

declare module "csstype" {
  interface Properties {
    "--tree-view-color"?: string
    "--tree-view-bg-color"?: string
  }
}

interface TocItemProps extends TreeItemProps {
  name: string
  number?: string
}

const TocItem: FC<TocItemProps> = (props) => {
  const { nodeId, name, children } = props

  return (
    <TreeItem
      onContextMenu={popupMenu}
      nodeId={nodeId}
      label={
        <div className={styles.tocItem}>
          <Typography variant="body2">{name}</Typography>
          <Typography variant="caption" color="inherit">
            {/* {number} */}
          </Typography>
        </div>
      }
      classes={
        {
          // root:
        }
      }
      style={
        {
          // color: '#e3742f',
          // backgroundColor: '#e8f0fe'
        }
      }
    >
      {children}
    </TreeItem>
  )
}

const Toc: FC = () => {
  return (
    <TreeView
      className={styles.root}
      defaultCollapseIcon={<ArrowDropDown  />}
      defaultExpandIcon={<ArrowRight  />}
      defaultEndIcon={<div style={{ width: 24 }} />}
    >
      <TocItem nodeId="1" name="学术" number="90">
        <TocItem nodeId="1.1" name="数学" number="90" />
        <TocItem nodeId="1.2" name="软件工程" number="90" />
        <TocItem nodeId="1.3" name="程序原理" number="90" />
      </TocItem>
      <TocItem nodeId="2" name="Thinking" number="90" />
      <TocItem nodeId="3" name="程序设计语言" number="90">
        <TocItem nodeId="3.1" name="Rust" number="90" />
        <TocItem nodeId="3.2" name="C/C++" number="90" />
        <TocItem nodeId="3.3" name="JavaScript" number="90" />
      </TocItem>
      <TocItem nodeId="4" name="重要" number="90" />
      <TocItem nodeId="5" name="Web" number="90" />
    </TreeView>
  )
}

export default Toc
