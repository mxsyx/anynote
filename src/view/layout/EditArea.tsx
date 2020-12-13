import React, { FC, useState, useCallback, ChangeEvent, useEffect } from 'react'
import { Grid, Input, Button } from '@material-ui/core'
import { makeStyles } from '@material-ui/core/styles'
import { Editor } from '@tinymce/tinymce-react'

import { editorInit } from 'constants'
import { SaveOutlined } from '@material-ui/icons'
import eventProxy from 'utils/event_proxy'
import { Note } from '../types'

const { note: noteHandler } = anynote.handlers

const useStyles = makeStyles(
  {
    title: {
      width: '100%',
      '&::before': {
        display: 'none'
      },
      '&::after': {
        display: 'none'
      }
    },
    updateTime: {
      fontSize: 14,
      color: '#BFBFBF'
    }
  },
  { name: 'EditArea' }
)

const EditorArea: FC = () => {
  const styles = useStyles()
  const [note, setNote] = useState<Note>()

  const [title, setTitle] = useState<string>('')
  const [content, setContent] = useState<string>('')

  useEffect(() => {
    eventProxy.on('Note-Switch', (note: Note) => {
      setNote(note)
      setTitle(note.title)
      setContent(note.content)
    })
  }, [])

  const handleSave = useCallback(() => {
    if (!note) return
    note.title = title
    note.content = content
    noteHandler.changeTitle('44196fb2-0658-4f66-871a-74a4e3668083', note.id, title)
    noteHandler.updateContent('44196fb2-0658-4f66-871a-74a4e3668083', note.id, content)
  }, [title, content, note])

  const handleEditorChange = useCallback((content: string) => {
    setContent(content)
  }, [])

  const handleTitleChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => {
      setTitle(e.target.value)
    },
    [note]
  )

  return (
    <Grid container direction="column" style={{ height: '100%' }}>
      <Grid item>
        <Grid container>
          <Grid item xs={8}>
            <Input value={title} onChange={handleTitleChange} className={styles.title} />
          </Grid>
          <Grid item xs={4}>
            <span className={styles.updateTime}>最后更新于 2020-08-02 21:26:00</span>
            <Button size="small" startIcon={<SaveOutlined />} onClick={handleSave}>
              保存
            </Button>
          </Grid>
        </Grid>
      </Grid>
      <Grid item style={{ flexGrow: 1 }}>
        <Editor
          tinymceScriptSrc="assets/tinymce/tinymce.min.js"
          init={editorInit}
          onEditorChange={handleEditorChange}
          value={content}
        />
      </Grid>
    </Grid>
  )
}

export default EditorArea
