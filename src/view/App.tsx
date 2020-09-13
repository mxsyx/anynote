import React, { FC } from 'react'
import { Grid } from '@material-ui/core'

import { Toc, Preview, EditArea } from './layout'
import Collapse from './components/Collapse'
import bg from 'assets/sidebar.jpg'

const App: FC = () => {
  return (
    <Grid container>
      <Grid
        item
        style={{
          flex: '0 0 12%',
          minHeight: '100vh',
          backgroundImage: `url(${bg})`,
          backgroundSize: '100% 100%'
        }}
      >
        <Collapse summary="我的笔记本">
          <Toc />
        </Collapse>
        <Collapse summary="收藏" />
        <Collapse summary="标签" />
      </Grid>
      <Grid item style={{ flex: '0 0 18%' }}>
        <Preview />
      </Grid>
      <Grid item style={{ flex: '0 0 70%' }}>
        <EditArea />
      </Grid>
    </Grid>
  )
}

export default App
