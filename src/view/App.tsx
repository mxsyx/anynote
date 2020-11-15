import React, { FC } from 'react'
import { Grid } from '@material-ui/core'

import { Toc, Preview, EditArea } from './layout'
import Collapse from './components/Collapse'
import bg from 'assets/sidebar.jpg'
import { popupCollapseNote } from 'utils/menu/collapse'

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
        <Collapse title="我的笔记本" onContextNemu={e => popupCollapseNote(e)}>
          <Toc />
        </Collapse>
        <Collapse title="收藏" />
        <Collapse title="标签" />
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
 