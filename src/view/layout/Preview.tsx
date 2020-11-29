import React, { FC, useEffect, useState } from 'react'
import { makeStyles } from '@material-ui/core/styles'
import eventProxy from 'utils/event_proxy'
import { Note } from 'types'
import PreCard from './PreCard'

const useStyles = makeStyles(
  {
    root: {
      backgroundColor: '#f8f9fc',
      height: '100%',
      borderTopLeftRadius: 15,
      borderBottomLeftRadius: 15,
      minWidth: 260,
      overflowY: 'scroll'
    }
  },
  { name: 'Preview' }
)

const { note: noteHandler } = anynote.handlers

const Preview: FC = () => {
  const styles = useStyles()
  const [noteList, setNoteList] = useState<Note[]>([])
  const [fid, setFid] = useState<string>('')

  useEffect(() => {
    eventProxy.on('Folder-Switch', (payload: AnyObject) => {
      setFid(payload.fid)
      noteHandler.getList(payload.fid).then(notes => {
        setNoteList(notes)
      })
    })
  }, [])

  return (
    <div className={styles.root}>
      {noteList.map(note => (
        <PreCard
          key={note.id}
          nid={note.id}
          fid={fid}
          title={note.title}
          content={note.content}
          type={note.type}
          uTime={note.uTime}
        />
      ))}
    </div>
  )
}

export default Preview
