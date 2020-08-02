import React, { FC } from "react"
import { Grid } from "@material-ui/core"

import Toc from "./Toc"
import Preview from "./Preview"
import EditorArea from './EditorArea'

const App: FC = () => {
  return (
    <Grid container>
      <Grid item style={{ flex: "0 0 12%" }}>
        <Toc />
      </Grid>
      <Grid item style={{ flex: "0 0 18%" }}>
        <Preview />
      </Grid> 
      <Grid item style={{ flex: "0 0 70%" }}>
        <EditorArea />
      </Grid>
    </Grid>
  )
}

export default App
