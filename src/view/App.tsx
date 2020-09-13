import React, { FC, useState } from "react"
import { Accordion, AccordionDetails, AccordionSummary, Grid } from "@material-ui/core"
import { ExpandMoreRounded} from "@material-ui/icons"
import Toc from "./Toc"
import Preview from "./Preview"
import EditorArea from './EditorArea'
import styles from './index.css'

const App: FC = () => {
  const [expanded, setExpanded] = useState<string>();
  const handleChange = (panel: string) => () => {
    setExpanded(!expanded ? panel : '');
  };

  return (
    <Grid container>
      <Grid item style={{ flex: "0 0 16%" }} style={{minHeight: '100vh'}}>
        <Accordion
          expanded={expanded === 'panel-note'} 
          onChange={handleChange('panel-note')}
        > 
          <AccordionSummary 
            id="panel-note"
            expandIcon={<ExpandMoreRounded />}
            className={styles.panelSummary}
          >
            我的笔记本
          </AccordionSummary>
          <AccordionDetails>
            <Toc />
          </AccordionDetails>
        </Accordion>
        <Accordion 
          expanded={expanded === 'panel-star'}
          onChange={handleChange('panel-star')}
        >
          <AccordionSummary
            id="panel-star"
            expandIcon={<ExpandMoreRounded />}
            className={styles.panelSummary}
          >收藏</AccordionSummary>
        </Accordion>
        <Accordion 
          expanded={expanded === 'panel-tag'}
          onChange={handleChange('panel-tag')}
        >
          <AccordionSummary
            id="panel-tag"
            expandIcon={<ExpandMoreRounded />}
            className={styles.panelSummary}
          >标签</AccordionSummary>
        </Accordion>
      </Grid>
      <Grid item style={{ flex: "0 0 18%" }}>
        <Preview />
      </Grid>
      <Grid item style={{ flex: "0 0 66%" }}>
        <EditorArea />
      </Grid>
    </Grid>
  )
}

export default App
