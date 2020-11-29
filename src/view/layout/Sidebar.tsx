/*
 * File: /src/view/layout/Sidebar.tsx
 * Author: Mxsyx (mxsyxin@gmail.com)
 * Created At: 2020-11-29 08:31:58
 * -----
 * Last Modified: 2020-11-29 08:32:02
 * Modified By: Mxsyx (mxsyxin@gmail.com>)
 * -----
 * Lisense: GNU General Public License v3
 */
import React, { FC, useState } from 'react'
import { Tabs, Tab } from '@material-ui/core'
import { makeStyles } from '@material-ui/core/styles'
import { InsertDriveFileOutlined, LocalOfferOutlined, StarBorderOutlined } from '@material-ui/icons'

const useStyles = makeStyles(() => ({
  tab: {
    minWidth: 60
  }
}))

function makeProps(index: number) {
  return {
    id: `vertical-tab-${index}`,
    'aria-controls': `vertical-tabpanel-${index}`
  }
}

interface Props {
  onChange: (newValue: number) => void
}

const Sidebar: FC<Props> = props => {
  const styles = useStyles()
  const [value, setValue] = useState<number>(0)

  // eslint-disable-next-line @typescript-eslint/ban-types
  const handleChange = (event: React.ChangeEvent<{}>, newValue: number) => {
    setValue(newValue)
    props.onChange(newValue)
  }

  return (
    <Tabs orientation="vertical" variant="scrollable" value={value} onChange={handleChange}>
      <Tab
        classes={{ root: styles.tab }}
        icon={<InsertDriveFileOutlined style={{ color: '#fff' }} />}
        {...makeProps(0)}
      />
      <Tab
        classes={{ root: styles.tab }}
        icon={<LocalOfferOutlined style={{ color: '#fff' }} />}
        {...makeProps(1)}
      />
      <Tab
        classes={{ root: styles.tab }}
        icon={<StarBorderOutlined style={{ color: '#fff' }} />}
        {...makeProps(2)}
      />
    </Tabs>
  )
}

export default Sidebar
