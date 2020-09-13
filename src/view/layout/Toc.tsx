import React, { FC } from "react"
import { Typography } from "@material-ui/core"
import { TreeView, TreeItem, TreeItemProps } from "@material-ui/lab"
import { makeStyles } from '@material-ui/core/styles'
import {ArrowDropDown, ArrowRight,} from "@material-ui/icons"

import popupMenu from 'utils/menu'

const useStyles = makeStyles({
  root: {
    height: 264,
    flexGrow: 1,
    maxWidth: 400
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    userSelect: 'none',
    color: '#FFFFFF',
    borderTopRightRadius: 8,
    borderBottomRightRadius: 8,
    padding: '5px 0px'
  }
}, {name: 'Toc'})

interface TocItemProps extends TreeItemProps {
  name: string
  number?: string
}

const TocItem: FC<TocItemProps> = (props) => {
  const styles = useStyles()
  const { nodeId, name, children } = props

  return (
    <TreeItem
      onContextMenu={(e) => popupMenu(e, {fid: 'xxx-xxx-x'})}
      nodeId={nodeId}
      label={
        <div className={styles.item}>
          <Typography variant="body2">{name}</Typography>
          <Typography variant="caption" color="inherit">
            {/* {number} */}
          </Typography>
        </div>
      }
    >
      {children}
    </TreeItem>
  )
}

const Toc: FC = () => {
  const styles = useStyles()

  return ( 
    <TreeView
      classes={{root: styles.root}}
      defaultCollapseIcon={<ArrowDropDown style={{color: '#FFFFFF'}} />}
      defaultExpandIcon={<ArrowRight style={{color: '#FFFFFF'}} />}
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
