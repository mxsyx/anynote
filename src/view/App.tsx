import React, { FC, useState } from 'react'
import { Grid } from '@material-ui/core'
import { hot } from 'react-hot-loader/root'

import { Sidebar, Panel, Toc, EditArea, Preview } from './layout'

const App: FC = () => {
  const [value, setValue] = useState<number>(0)

  const handleChange = (newValue: number) => {
    setValue(newValue)
  }

  return (
    <Grid container wrap="nowrap">
      <Grid item style={{ height: '100vh', backgroundColor: '#02192E' }}>
        <Sidebar onChange={handleChange} />
      </Grid>
      <Grid item style={{ height: '100vh', flexGrow: 1 }}>
        <Panel value={value} index={0}>
          <Grid container>
            <Grid item style={{ height: '100vh' }}>
              <Toc />
            </Grid>
            <Grid item style={{ height: '100vh' }}>
              <Preview />
            </Grid>
            <Grid item style={{ height: '100vh', flexGrow: 1 }}>
             <EditArea />
            </Grid>
          </Grid>
        </Panel>
      </Grid>
    </Grid>
  )
}

export default hot(App)
