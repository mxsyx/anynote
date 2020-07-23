import React, { FC } from "react";
import { makeStyles, Theme, createStyles } from "@material-ui/core/styles";
import { TreeView, TreeItem, TreeItemProps } from "@material-ui/lab";
import { Typography, Icon } from "@material-ui/core";
import {
  Label,
  Mail,
  Delete,
  Info,
  SupervisorAccount,
  Forum,
  LocalOffer,
  ArrowDropDown,
  ArrowRight,
} from "@material-ui/icons";
import { SvgIconProps } from "@material-ui/core/SvgIcon";

import styles from "./index.css";

declare module "csstype" {
  interface Properties {
    "--tree-view-color"?: string;
    "--tree-view-bg-color"?: string;
  }
}

interface TocItemProps extends TreeItemProps {
  name: string;
  icon: React.ElementType<SvgIconProps>;
  number?: string;
}

const TocItem: FC<TocItemProps> = (props) => {
  const { nodeId, name, icon: Icon, number, children } = props;

  return (
    <TreeItem
      nodeId={nodeId}
      className={styles.tocItem}
      label={
        <div className={styles.tocItem}>
          <Icon />
          <Typography variant="body2">{name}</Typography>
          <Typography variant="caption" color="inherit">
            {number}
          </Typography>
        </div>
      }
      classes={
        {
          // root:
        }
      }
    >
      {children}
    </TreeItem>
  );
};

const Toc: FC = () => {
  return (
    <TreeView
      className={styles.root}
      defaultExpanded={["3"]}
      defaultCollapseIcon={<ArrowDropDown />}
      defaultExpandIcon={<ArrowRight />}
      defaultEndIcon={<div style={{ width: 24 }} />}
    >
      <TocItem nodeId="1" name="All Mail" icon={Mail} number="90" />
      <TocItem nodeId="2" name="Trash" icon={Delete} number="90" />
      <TocItem nodeId="3" name="Categories" icon={Label} number="90">
        <TocItem
          nodeId="5"
          name="Social"
          icon={SupervisorAccount}
          number="90"
        />
        <TocItem nodeId="6" name="Updates" icon={Info} number="90" />
        <TocItem
          nodeId="7"
          name="Social"
          icon={SupervisorAccount}
          number="90"
        />
        <TocItem nodeId="8" name="Updates" icon={Info} number="90" />
      </TocItem>
      <TocItem nodeId="4" name="History" icon={Label} />
    </TreeView>
  );
};

export default Toc;
