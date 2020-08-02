import React, { FC, useCallback, useState } from "react"
import { Grid, Input, Button } from "@material-ui/core"
import { Editor } from "@tinymce/tinymce-react"

import { editorInit } from 'constants'
import styles from './index.css'

const ipcRenderer = window.electron.ipcRenderer

const EditorArea: FC = () => {
  const [content, setContent] = useState<string>("")

  const handleEditorChange = useCallback((newContent) => {
    setContent(newContent)
  }, []) 

  return (
    <div>
      <Grid container>
        <Grid item xs={8}>
          <Input className={styles.title}/>
        </Grid>
        <Grid item xs={4}>
          <span className={styles.updateTime}>最后更新于 2020-08-02 21:26:00</span>
          <Button>保存</Button>
        </Grid>
      </Grid>
      <Editor
        tinymceScriptSrc="assets/tinymce/tinymce.min.js"
        init={editorInit}
        onEditorChange={handleEditorChange}
      />
    </div>
  )
}

export default EditorArea
