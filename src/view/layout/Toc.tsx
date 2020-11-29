import React, { ChangeEvent, FC, useCallback, useEffect, useState } from 'react'
import { Input, Typography } from '@material-ui/core'
import { TreeView, TreeItem, TreeItemProps } from '@material-ui/lab'
import { ArrowDropDown, ArrowRight } from '@material-ui/icons'
import { makeStyles } from '@material-ui/core/styles'

import popupMenu, { TocEvent } from 'utils/menu/toc'
import eventProxy from 'utils/event_proxy'
import bgimg from 'assets/sidebar.jpg'

const { folder: folderHander } = anynote.handlers

const useStyles = makeStyles(
  {
    root: {
      width: 220,
      height: '100vh',
      backgroundImage: `url(${bgimg})`,
      backgroundSize: '100% 100%',
      borderTopRightRadius: 10
    },
    item: {
      display: 'flex',
      alignItems: 'center',
      userSelect: 'none',
      color: '#FFFFFF',
      borderTopRightRadius: 8,
      borderBottomRightRadius: 8,
      padding: '5px 0px'
    },
    input: {
      color: '#FFF',
      cursor: 'pointer'
    }
  },
  { name: 'Toc' }
)

interface Props extends TreeItemProps {
  name: string
  total?: number
}
const TocItem: FC<Props> = props => {
  const { nodeId, name, children } = props

  const styles = useStyles()
  const [editable, setEditable] = useState<boolean>(false)
  const [tmpName, setTmpName] = useState<string>(name)

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => {
      setTmpName(event.target.value)
    },
    [setTmpName]
  )

  // The rename operation in the database should be performed when the input box loses focus.
  const handleBlur = useCallback(() => {
    folderHander
      .rename(nodeId, tmpName)
      .then(() => {
        eventProxy.trigger('Folder-Created')
      })
      .catch(error => {
        anynote.remote.dialog.showErrorBox('重命名笔记本时出现错误', error)
      })
    setEditable(false)
  }, [setEditable, nodeId, tmpName])

  useEffect(() => {
    eventProxy.on('Folder-Before-Rename', (payload: TocEvent) => {
      payload.fid === nodeId && setEditable(true)
    })
  }, [nodeId, setEditable])

  return (
    <TreeItem
      onContextMenu={e => popupMenu(e, { fid: nodeId })}
      nodeId={nodeId}
      label={
        <div className={styles.item}>
          <Input
            type="text"
            value={tmpName}
            readOnly={!editable}
            disableUnderline={!editable}
            classes={{ input: styles.input }}
            onChange={handleChange}
            onBlur={handleBlur}
          />
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
  id: string
  name: string
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
    eventProxy.on('Folder-Created', generateToc)
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
