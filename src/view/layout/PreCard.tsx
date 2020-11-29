import React, { FC, MouseEvent, useCallback, useState } from 'react'
import { makeStyles, Theme, createStyles } from '@material-ui/core/styles'
import clsx from 'clsx'
import Card from '@material-ui/core/Card'
import CardHeader from '@material-ui/core/CardHeader'
import CardContent from '@material-ui/core/CardContent'
import CardActions from '@material-ui/core/CardActions'
import Collapse from '@material-ui/core/Collapse'
import Avatar from '@material-ui/core/Avatar'
import IconButton from '@material-ui/core/IconButton'
import Typography from '@material-ui/core/Typography'
import { red } from '@material-ui/core/colors'
import FavoriteIcon from '@material-ui/icons/Favorite'
import ShareIcon from '@material-ui/icons/Share'
import ExpandMoreIcon from '@material-ui/icons/ExpandMore'
import { Menu, MenuItem } from '@material-ui/core'
import { MoreVertOutlined } from '@material-ui/icons'
import eventProxy from 'utils/event_proxy'

const useStyles = makeStyles((theme: Theme) =>
  createStyles({
    root: {
      maxWidth: 345
    },
    media: {
      height: 0,
      paddingTop: '56.25%' // 16:9
    },
    expand: {
      transform: 'rotate(0deg)',
      marginLeft: 'auto',
      transition: theme.transitions.create('transform', {
        duration: theme.transitions.duration.shortest
      })
    },
    expandOpen: {
      transform: 'rotate(180deg)'
    },
    avatar: {
      backgroundColor: red[500]
    }
  })
)

const { note: noteHandler, trash: trashHandler } = anynote.handlers

interface Props {
  nid: string
  fid: string
  title: string
  uTime: string
  type: 'R' | 'M'
  content: string
}

function makeSummary(content: string): string {
  const summary = content.slice(0, 60)
  return summary.length < content.length ? `${summary}...` : summary
}

const PreCard: FC<Props> = props => {
  const { nid, fid, title, uTime, type, content } = props

  const classes = useStyles()
  const [expanded, setExpanded] = useState(false)
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null)

  const handleClick = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    setAnchorEl(event.currentTarget)
  }, [])

  const handleClose = useCallback(() => {
    setAnchorEl(null)
  }, [])

  const handleExpandClick = useCallback(() => {
    setExpanded(!expanded)
  }, [])

  const handleDelete = useCallback(() => {
    trashHandler
      .create({ type, title, content })
      .then(() => {
        noteHandler.delete(fid, nid).then(() => {
          eventProxy.trigger('Folder-Switch', { fid })
        })
      })
      .finally(() => {
        setAnchorEl(null)
      })
  }, [nid, fid])

  return (
    <Card className={classes.root}>
      <CardHeader
        avatar={
          <Avatar aria-label="recipe" className={classes.avatar}>
            M
          </Avatar>
        }
        action={
          <IconButton onClick={handleClick}>
            <MoreVertOutlined />
          </IconButton>
        }
        title={title}
        subheader={uTime}
      />
      <Menu
        id="simple-menu"
        anchorEl={anchorEl}
        keepMounted
        open={Boolean(anchorEl)}
        onClose={handleClose}
      >
        <MenuItem onClick={handleClose}>置顶</MenuItem>
        <MenuItem onClick={handleDelete}>删除笔记</MenuItem>
      </Menu>
      <CardContent>
        <Typography variant="body2" color="textSecondary" component="p">
          {makeSummary(content)}
        </Typography>
      </CardContent>
      <CardActions disableSpacing>
        <IconButton aria-label="add to favorites">
          <FavoriteIcon />
        </IconButton>
        <IconButton aria-label="share">
          <ShareIcon />
        </IconButton>
        <IconButton
          className={clsx(classes.expand, {
            [classes.expandOpen]: expanded
          })}
          onClick={handleExpandClick}
          aria-expanded={expanded}
          aria-label="show more"
        >
          <ExpandMoreIcon />
        </IconButton>
      </CardActions>
      <Collapse in={expanded} timeout="auto" unmountOnExit>
        <CardContent>{content}</CardContent>
      </Collapse>
    </Card>
  )
}

export default PreCard
