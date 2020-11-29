import React, { FC } from 'react'
import { makeStyles } from '@material-ui/core/styles'

const useStyles = makeStyles({
  root: {
    backgroundColor: '#f8f9fc',
    height: '100%',
    borderTopLeftRadius: 15,
    borderBottomLeftRadius: 15,
    minWidth: 260
  }
}, {name: 'Preview'})

const Preview: FC = () => {
  const styles = useStyles()

  return <div className={styles.root}></div>
}

export default Preview
