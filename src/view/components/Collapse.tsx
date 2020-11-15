import React, { FC, ReactNode, useState } from 'react'
import { makeStyles } from '@material-ui/core/styles'
import { Accordion, AccordionDetails, AccordionSummary } from '@material-ui/core'
import { ExpandMoreRounded } from '@material-ui/icons'

const useStyles = makeStyles({
  root: {
    boxShadow: 'none',
    '&$expanded': {
      margin: 0
    }
  },
  summary: {
    minHeight: 35,
    '&$expanded': {
      minHeight: 35
    }
  },
  content: {
    margin: 0,
    color: '#FFFFFF',
    '&$expanded': {
      margin: 0
    }
  },
  expandIcon: {
    padding: 0,
    color: '#FFFFFF'
  },
  rounded: {
    '&:first-child': {
      borderRadius: 0
    },
    '&:last-child': {
      borderRadius: 0
    }
  },
  expanded: {}
}, { name: 'callapse' })

interface Props {
  title: ReactNode,
  onContextNemu?: (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => void
}

const Collapse: FC<Props> = (props) => {
  const classes = useStyles()
  const [expanded, setExpanded] = useState<boolean>(false)
  const handleChange = () => setExpanded(!expanded)
  
  return (
    <Accordion
      expanded={expanded}
      onChange={handleChange}
      style={{ background: 'transparent' }}
      classes={{
        root: classes.root,
        expanded: classes.expanded,
        rounded: classes.rounded
      }}
    >
      <AccordionSummary
        expandIcon={<ExpandMoreRounded />}
        classes={{
          root: classes.summary,
          content: classes.content,
          expandIcon: classes.expandIcon,
          expanded: classes.expanded
        }}
        onContextMenu={props.onContextNemu}
      >
        {props.title}
      </AccordionSummary>
      <AccordionDetails>
        {props.children}
      </AccordionDetails>
    </Accordion>
  )
}

export default Collapse
