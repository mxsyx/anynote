import React, { FC, useCallback, useEffect, useState } from 'react'
import { Typography } from '@material-ui/core'
import { TreeView, TreeItem, TreeItemProps } from '@material-ui/lab'
import { ArrowDropDown, ArrowRight } from '@material-ui/icons'
import { makeStyles } from '@material-ui/core/styles'

import popupMenu from 'utils/menu/toc'
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
  total?: number
} 
const TocItem: FC<Props> = props => {
  const styles = useStyles()
  const { nodeId, name, total, children } = props
 
  return (
    <TreeItem
      onContextMenu={e => popupMenu(e, { fid: nodeId })}
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

interface TreeItemData {
  id: string,
  name: string,
  children?: TreeItemData[]
}

const Toc: FC = () => {
  const styles = useStyles()
  const [treeData, setTreeData] = useState<TreeItemData[]>([])

  const generateToc = useCallback(() => {
    folderHander.getList().then(folders => {
      const treeData: TreeItemData[] = []

      // Build top level folder.
      const topFolders = folders.filter(folder => folder.pid === null)
      topFolders.forEach(topFolder => {
        treeData.push({
          id: topFolder.id,
          name: topFolder.name
        })
      })

      function gen(list: TreeItemData[]) {
        list.forEach(item => {
          const subFolders = folders.filter(folder => folder.pid === item.id)
          item.children = subFolders.map(subFolder => ({
            id: subFolder.id,
            name: subFolder.name
          }))              
          gen(item.children)
        })         
        return list
      }
      setTreeData(gen(topFolders))
    })
  }, [])

  useEffect(() => {
    eventProxy.on('Folder-Create', generateToc)
    generateToc()
  }, [generateToc])

  const renderTree = useCallback(
    (treeData: TreeItemData[]) => {
      return treeData.map(folder => (
        <TocItem key={folder.id} nodeId={folder.id} name={folder.name}>
          {Array.isArray(folder.children) ? renderTree(folder.children) : null}
        </TocItem>
      ))
    }, 
    [treeData]
  )

  return (
    <TreeView
      classes={{ root: styles.root }}
      defaultCollapseIcon={<ArrowDropDown style={{ color: '#FFFFFF' }} />}
      defaultExpandIcon={<ArrowRight style={{ color: '#FFFFFF' }} />}
      defaultEndIcon={<div style={{ width: 24 }} />}
    >
      {renderTree(treeData)}
    </TreeView>
  )
}

export default Toc
