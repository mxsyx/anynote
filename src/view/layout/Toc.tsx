import React, { FC, useCallback, useEffect, useState } from 'react'
import { Typography } from '@material-ui/core'
import { TreeView, TreeItem, TreeItemProps } from '@material-ui/lab'
import { ArrowDropDown, ArrowRight } from '@material-ui/icons'
import { makeStyles } from '@material-ui/core/styles'

import popupMenu from 'utils/menu/toc'
import { Folder } from 'types'
import eventProxy from 'utils/event_proxy'

const { folder: folderHander } = anynote.handlers

const useStyles = makeStyles(
  {
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
  },
  { name: 'Toc' }
)

interface Props extends TreeItemProps {
  name: string
  number?: number
}
const TocItem: FC<Props> = props => {
  const styles = useStyles()
  const { nodeId, name, children } = props

  return (
    <TreeItem
      onContextMenu={e => popupMenu(e, { fid: props.nodeId })}
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
  const [folders, setFolders] = useState<Folder[]>([])

  const generateToc = useCallback(() => {
    folderHander.getList().then(folders => setFolders(folders))
  }, [])

  useEffect(() => {
    eventProxy.on('Folder-Create', generateToc)
    generateToc()
  }, [generateToc])

  return (
    <TreeView
      classes={{ root: styles.root }}
      defaultCollapseIcon={<ArrowDropDown style={{ color: '#FFFFFF' }} />}
      defaultExpandIcon={<ArrowRight style={{ color: '#FFFFFF' }} />}
      defaultEndIcon={<div style={{ width: 24 }} />}
    >
      {folders.map(folder => (
        <TocItem key={folder.id} nodeId={folder.id} name={folder.name} number={folder.total} />
      ))}
    </TreeView>
  )
}

export default Toc
